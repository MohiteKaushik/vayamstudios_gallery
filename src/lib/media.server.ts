/**
 * Where uploaded images live, and how they get back out.
 *
 * LAYOUT
 *
 *   photo/{collection}/{photo}        the stored image
 *   thumb/{collection}/{photo}        the grid-sized copy
 *   meta/photo/{collection}/{photo}   its record
 *
 * Every key is derived from two ids, never stored, so nothing can drift out of
 * step. Both ids are checked against a UUID shape before they touch a key: a
 * collection id of `../../meta/member` would otherwise read somebody's account
 * record straight out of the bucket.
 *
 * WHY THESE GO THROUGH THE WORKER
 *
 * The bucket has a public r2.dev address, so anything in it is readable by
 * anyone holding the key. These are photographs of identifiable people at
 * private events, so the paths below require a session instead. The public
 * address stays available for assets where that does not matter.
 *
 * WHAT THAT COSTS, AND WHY IT IS FINE
 *
 * A Worker request per photo view would be expensive if every view hit it.
 * Keys are immutable, so responses carry a long immutable cache header and
 * answer a repeat view with a 304. A member scrolling back through their
 * gallery re-reads nothing and re-downloads nothing.
 */

import {
  verifySessionToken,
  readCookie,
  createSessionToken,
  sessionCookieHeader,
  isSecureRequest,
} from "./auth/session.ts";
import {
  getMemberById,
  getMemberByEmail,
  createMember,
  ensureRole,
} from "./auth/members.server.ts";
import { indexPhotoFaces, type VectorizeIndex } from "./face-index.server.ts";
import type { R2Bucket } from "./storage.server.ts";

export type MediaEnv = {
  PHOTOS: R2Bucket;
  SESSION_SECRET?: string;
  /**
   * The face index. Optional so local development runs without it: Cloudflare
   * cannot emulate Vectorize, and refusing to boot without it would make the
   * whole app undevelopable offline.
   */
  FACE_INDEX?: VectorizeIndex;
  /** Which address gets the operator role. */
  ADMIN_EMAIL?: string;
  /** Only used by the session bridge, and only until sign-in moves across. */
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
};

/** Prefix every image route sits under. */
export const MEDIA_PREFIX = "/media";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids come from URLs, so they are untrusted until they look like ids. */
export function isSafeId(value: string): boolean {
  return UUID.test(value);
}

export const photoKey = (cid: string, photoId: string) => `photo/${cid}/${photoId}`;
export const thumbKey = (cid: string, photoId: string) => `thumb/${cid}/${photoId}`;
export const photoMetaKey = (cid: string, photoId: string) => `meta/photo/${cid}/${photoId}`;

/** Only formats we actually produce. Anything else is refused rather than stored. */
const ALLOWED_TYPES = new Set(["image/avif", "image/webp", "image/jpeg", "image/png"]);

/** Cloudflare accepts far larger, but a single gallery photo has no business being bigger. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export type PhotoMeta = {
  id: string;
  collectionId: string;
  fileName: string;
  contentType: string;
  bytes: number;
  width: number;
  height: number;
  facesCount: number;
  uploadedBy: string;
  createdAt: number;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** Resolves the caller from their session cookie, or null. */
export async function currentUserId(request: Request, env: MediaEnv): Promise<string | null> {
  const secret = env.SESSION_SECRET;
  if (!secret) return null;
  const claims = await verifySessionToken(readCookie(request), secret);
  return claims?.sub ?? null;
}

/**
 * Streams an object out of R2 behind the caller's authorisation.
 *
 * The long max-age is safe because a photo id is minted once and its bytes
 * never change. `private` keeps it in that member's browser rather than a
 * shared cache, since collections are not public.
 */
export async function serveObject(
  bucket: R2Bucket,
  key: string,
  request: Request,
): Promise<Response> {
  const object = await bucket.get(key);
  if (!object) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, max-age=31536000, immutable");

  if (request.headers.get("if-none-match") === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(object.body, { headers });
}

/**
 * Handles an image route, or returns null so the request falls through to the
 * app. Returning null rather than a 404 is what keeps this from swallowing
 * every unmatched path in the product.
 */
export async function handleMediaRequest(
  request: Request,
  env: MediaEnv,
): Promise<Response | null> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  if (!url.pathname.startsWith(MEDIA_PREFIX + "/")) return null;

  const segments = url.pathname.slice(MEDIA_PREFIX.length + 1).split("/");
  const [kind, ...rest] = segments;

  if (kind === "session") return handleSessionExchange(request, env);
  if (kind === "upload") return handleUpload(request, env, url);
  if (kind === "index") return handleIndex(request, env);

  // /media/p/{collection}/{photo} and /media/t/{collection}/{photo}
  if (kind !== "p" && kind !== "t") return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  const [cid, photoId] = rest;
  if (!cid || !photoId || !isSafeId(cid) || !isSafeId(photoId)) {
    return new Response("Not found", { status: 404 });
  }

  const userId = await currentUserId(request, env);
  if (!userId) return new Response("Sign in to view this photo", { status: 401 });

  const key = kind === "t" ? thumbKey(cid, photoId) : photoKey(cid, photoId);
  return serveObject(env.PHOTOS, key, request);
}

/**
 * Accepts one uploaded image.
 *
 * Raw bytes with the details in headers, rather than multipart, because the
 * browser already holds an encoded Blob and re-wrapping it in a form only adds
 * parsing on both ends.
 */
async function handleUpload(request: Request, env: MediaEnv, url: URL): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const userId = await currentUserId(request, env);
  if (!userId) return json({ error: "Not signed in" }, 401);

  // Uploading is an operator action, checked against the stored record rather
  // than anything the request claims.
  const member = await getMemberById(env.PHOTOS, userId);
  if (!member || member.role !== "admin") return json({ error: "Admins only" }, 403);

  const cid = url.searchParams.get("collection") ?? "";
  if (!isSafeId(cid)) return json({ error: "Unknown collection" }, 400);

  const contentType = (request.headers.get("content-type") ?? "").split(";")[0]!.trim();
  if (!ALLOWED_TYPES.has(contentType)) return json({ error: `Unsupported type ${contentType}` }, 415);

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_UPLOAD_BYTES) return json({ error: "Photo is too large" }, 413);

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) return json({ error: "Empty upload" }, 400);
  // Re-check after reading: content-length is a claim, byteLength is the fact.
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return json({ error: "Photo is too large" }, 413);

  const isThumb = url.searchParams.get("kind") === "thumb";
  const photoId = url.searchParams.get("photo") ?? crypto.randomUUID();
  if (!isSafeId(photoId)) return json({ error: "Bad photo id" }, 400);

  const key = isThumb ? thumbKey(cid, photoId) : photoKey(cid, photoId);

  await env.PHOTOS.put(key, bytes, {
    httpMetadata: { contentType, cacheControl: "private, max-age=31536000, immutable" },
  });

  // The thumbnail is a second upload for the same photo, so it must not
  // overwrite the record the full image already wrote.
  if (!isThumb) {
    const meta: PhotoMeta = {
      id: photoId,
      collectionId: cid,
      fileName: request.headers.get("x-file-name") ?? "photo",
      contentType,
      bytes: bytes.byteLength,
      width: Number(request.headers.get("x-width") ?? 0),
      height: Number(request.headers.get("x-height") ?? 0),
      facesCount: Number(request.headers.get("x-faces") ?? 0),
      uploadedBy: userId,
      createdAt: Date.now(),
    };
    await env.PHOTOS.put(photoMetaKey(cid, photoId), JSON.stringify(meta), {
      httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
    });
    return json({ photoId, bytes: bytes.byteLength, url: mediaUrl(cid, photoId) }, 201);
  }

  return json({ photoId, bytes: bytes.byteLength, url: mediaUrl(cid, photoId, "t") }, 201);
}

/** The path a browser should request for a stored image. */
export function mediaUrl(cid: string, photoId: string, kind: "p" | "t" = "p"): string {
  return `${MEDIA_PREFIX}/${kind}/${cid}/${photoId}`;
}

/* -------------------------------------------------------------------------- */
/*                        Bridging the old session                            */
/* -------------------------------------------------------------------------- */

/**
 * Exchanges the sign-in the app currently uses for a session this Worker
 * accepts, and creates the member's R2 record on the way through.
 *
 * This exists because the migration is mid-flight. Sign-in still runs through
 * the old service while storage and search have already moved, so without this
 * every upload is refused by a Worker that has never seen the caller. Called
 * once per batch: after it, the cookie carries the session and nothing else
 * touches the old service, so a forty thousand photo upload does not make forty
 * thousand round trips to verify a token.
 *
 * It goes away when sign-in itself moves across. Until then it is the only
 * thing in the media path that still knows the old service exists.
 */
async function handleSessionExchange(request: Request, env: MediaEnv): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!env.SESSION_SECRET) return json({ error: "SESSION_SECRET is not configured" }, 500);

  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return json({ error: "No token supplied" }, 401);

  const identity = await verifyLegacyToken(token, env);
  if (!identity) return json({ error: "That sign-in is not valid" }, 401);

  const member = await findOrCreateBridgedMember(env, identity.email);
  if (!member) return json({ error: "Could not prepare your account" }, 500);

  const sessionToken = await createSessionToken(member.id, env.SESSION_SECRET);
  return new Response(
    JSON.stringify({ id: member.id, email: member.email, role: member.role }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "set-cookie": sessionCookieHeader(sessionToken, { secure: isSecureRequest(request) }),
      },
    },
  );
}

/** Asks the old service who a token belongs to. One call, once per batch. */
async function verifyLegacyToken(
  token: string,
  env: MediaEnv,
): Promise<{ email: string } | null> {
  const base = env.SUPABASE_URL;
  const key = env.SUPABASE_PUBLISHABLE_KEY;
  if (!base || !key) return null;

  try {
    const res = await fetch(`${base}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: key },
    });
    if (!res.ok) return null;
    const user = (await res.json()) as { email?: string };
    return user.email ? { email: user.email } : null;
  } catch {
    return null;
  }
}

/**
 * Finds the member's R2 record, creating it the first time they arrive.
 *
 * The password is random and unusable on purpose: these accounts authenticate
 * through the old service, and inventing a guessable one would leave a way in
 * that nobody chose. Members set a real password when sign-in moves across.
 */
async function findOrCreateBridgedMember(env: MediaEnv, email: string) {
  const existing = await getMemberByEmail(env.PHOTOS, email);
  if (existing) return ensureRole(env.PHOTOS, existing, env.ADMIN_EMAIL);

  const unusable = crypto.randomUUID() + crypto.randomUUID();
  const created = await createMember(env.PHOTOS, {
    email,
    password: unusable,
    fullName: "",
    phone: "",
  });
  if (!created.ok) {
    // Lost a race with another tab doing the same thing. Whoever won is fine.
    const now = await getMemberByEmail(env.PHOTOS, email);
    return now ? ensureRole(env.PHOTOS, now, env.ADMIN_EMAIL) : null;
  }
  return ensureRole(env.PHOTOS, created.member, env.ADMIN_EMAIL);
}

/* -------------------------------------------------------------------------- */
/*                          Indexing a photo's faces                          */
/* -------------------------------------------------------------------------- */

export const facesKey = (cid: string, photoId: string) => `meta/faces/${cid}/${photoId}`;

/** Length of a face-api descriptor. A different length means a different model. */
export const DESCRIPTOR_DIM = 128;

/** Beyond this in one frame it is a crowd shot, and the tail is not worth storing. */
export const MAX_FACES_PER_PHOTO = 64;

export type IncomingFace = {
  descriptor: number[];
  box: { x: number; y: number; width: number; height: number };
  score: number;
};

/**
 * Records the faces found in one photo.
 *
 * Descriptors go to Vectorize, which is what makes a search over forty thousand
 * photos a handful of lookups instead of a scan. The bounding boxes go to R2
 * beside the photo, because they are only ever read for one photo at a time and
 * putting them in the index would force every query down to a lower result
 * ceiling to carry them.
 *
 * Detection runs in the browser, so what arrives here is untrusted: the
 * dimension is checked, the count is capped, and anything malformed is refused
 * rather than written.
 */
async function handleIndex(request: Request, env: MediaEnv): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const userId = await currentUserId(request, env);
  if (!userId) return json({ error: "Not signed in" }, 401);
  const member = await getMemberById(env.PHOTOS, userId);
  if (!member || member.role !== "admin") return json({ error: "Admins only" }, 403);

  let body: { collection?: string; photoId?: string; faces?: IncomingFace[] };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "Malformed body" }, 400);
  }

  const cid = body.collection ?? "";
  const photoId = body.photoId ?? "";
  if (!isSafeId(cid) || !isSafeId(photoId)) return json({ error: "Bad id" }, 400);

  const faces = Array.isArray(body.faces) ? body.faces.slice(0, MAX_FACES_PER_PHOTO) : [];
  for (const face of faces) {
    if (!Array.isArray(face?.descriptor) || face.descriptor.length !== DESCRIPTOR_DIM) {
      return json({ error: `Each descriptor must be ${DESCRIPTOR_DIM} numbers` }, 400);
    }
    if (face.descriptor.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
      return json({ error: "Descriptor contains a non-number" }, 400);
    }
  }

  // Boxes first. If the index write fails the photo is still browsable, and a
  // re-index can fill the gap; the reverse would leave searchable faces with no
  // way to draw them.
  await env.PHOTOS.put(
    facesKey(cid, photoId),
    JSON.stringify(faces.map((f) => ({ box: f.box, score: f.score }))),
    { httpMetadata: { contentType: "application/json", cacheControl: "no-store" } },
  );

  let indexed = 0;
  if (faces.length > 0) {
    if (!env.FACE_INDEX) {
      // Local development without Vectorize. Say so rather than pretend.
      return json({ indexed: 0, faces: faces.length, warning: "no-face-index" }, 202);
    }
    const result = await indexPhotoFaces(env.FACE_INDEX, {
      collectionId: cid,
      photoId,
      descriptors: faces.map((f) => f.descriptor),
    });
    indexed = result.indexed;
  }

  return json({ indexed, faces: faces.length }, 200);
}
