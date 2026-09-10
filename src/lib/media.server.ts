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

import { verifySessionToken, readCookie } from "./auth/session.ts";
import { getMemberById } from "./auth/members.server.ts";
import { indexPhotoFaces, removePhotoFaces, type VectorizeIndex } from "./face-index.server.ts";
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
  /** Operator password, used once to create the console account on first run. */
  ADMIN_PASSWORD?: string;
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

  if (kind === "upload") return handleUpload(request, env, url);
  if (kind === "index") return handleIndex(request, env);
  if (kind === "delete") return handleDelete(request, env);

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
/*                          Indexing a photo's faces                          */
/* -------------------------------------------------------------------------- */

export const facesKey = (cid: string, photoId: string) => `meta/faces/${cid}/${photoId}`;

/** Length of a face-api descriptor. A different length means a different model. */
export const DESCRIPTOR_DIM = 512;

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

  // R2 holds the descriptors as well as the boxes, and it is written first.
  //
  // That makes R2 the record of what was detected and Vectorize a derived
  // index that can be rebuilt from it. Without this, a photo indexed while the
  // index was unreachable would lose its faces permanently, and the only way
  // back would be re-uploading and re-detecting every photo. Detection is the
  // expensive step; never throw it away.
  await env.PHOTOS.put(
    facesKey(cid, photoId),
    JSON.stringify({
      photoId,
      collectionId: cid,
      indexedAt: null as number | null,
      faces: faces.map((f) => ({ box: f.box, score: f.score, descriptor: f.descriptor })),
    }),
    { httpMetadata: { contentType: "application/json", cacheControl: "no-store" } },
  );

  let indexed = 0;
  if (faces.length > 0) {
    if (!env.FACE_INDEX) {
      // Cloudflare cannot emulate Vectorize locally. The faces are safe in R2
      // and `npm run reindex` puts them in the index, so this is a delay rather
      // than a loss. Say which it is.
      return json(
        { indexed: 0, faces: faces.length, stored: true, warning: "no-face-index" },
        202,
      );
    }
    const result = await indexPhotoFaces(env.FACE_INDEX, {
      collectionId: cid,
      photoId,
      descriptors: faces.map((f) => f.descriptor),
    });
    indexed = result.indexed;

    // Mark it indexed so a rebuild knows what it can skip.
    if (indexed > 0) {
      await markIndexed(env, cid, photoId).catch(() => undefined);
    }
  }

  return json({ indexed, faces: faces.length, stored: true }, 200);
}

async function markIndexed(env: MediaEnv, cid: string, photoId: string): Promise<void> {
  const key = facesKey(cid, photoId);
  const existing = await env.PHOTOS.get(key);
  if (!existing) return;
  const record = await existing.json<{ faces: unknown[] }>();
  await env.PHOTOS.put(key, JSON.stringify({ ...record, indexedAt: Date.now() }), {
    httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
  });
}

export type StoredFaces = {
  photoId: string;
  collectionId: string;
  indexedAt: number | null;
  faces: { box: IncomingFace["box"]; score: number; descriptor: number[] }[];
};

/* -------------------------------------------------------------------------- */
/*                                 Deleting                                   */
/* -------------------------------------------------------------------------- */

/** How many photos one delete request may name. */
export const MAX_DELETE_BATCH = 500;

export type DeleteRequest = {
  collection: string;
  /** Specific photos, or omitted to delete the whole collection. */
  photos?: string[];
};

/**
 * Removes photos, or a whole collection.
 *
 * Four things exist per photo and all four have to go: the image, the
 * thumbnail, the record, and the faces. Deleting the image alone leaves the
 * photo in every grid and every past scan result, looking broken.
 *
 * Vectorize entries are removed too, otherwise a deleted photo keeps matching
 * and members are shown a result that 404s when they open it.
 *
 * Batched rather than one request per photo, because clearing a collection of
 * forty thousand would otherwise be forty thousand round trips.
 */
async function handleDelete(request: Request, env: MediaEnv): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const userId = await currentUserId(request, env);
  if (!userId) return json({ error: "Not signed in" }, 401);
  const member = await getMemberById(env.PHOTOS, userId);
  if (!member || member.role !== "admin") return json({ error: "Admins only" }, 403);

  let body: DeleteRequest;
  try {
    body = (await request.json()) as DeleteRequest;
  } catch {
    return json({ error: "Malformed body" }, 400);
  }

  const cid = body.collection ?? "";
  if (!isSafeId(cid)) return json({ error: "Unknown collection" }, 400);

  const wholeCollection = !Array.isArray(body.photos);
  let photoIds: string[];

  if (wholeCollection) {
    photoIds = await listPhotoIds(env.PHOTOS, cid);
  } else {
    photoIds = body.photos!.filter(isSafeId);
    if (photoIds.length === 0) return json({ error: "No photos named" }, 400);
    if (photoIds.length > MAX_DELETE_BATCH) {
      return json({ error: `At most ${MAX_DELETE_BATCH} photos per request` }, 413);
    }
  }

  let deleted = 0;
  let unindexed = 0;

  for (let i = 0; i < photoIds.length; i += 100) {
    const slice = photoIds.slice(i, i + 100);

    // Clear the index first. A photo removed from storage but left in the index
    // is worse than the reverse: it keeps appearing in searches and 404s.
    if (env.FACE_INDEX) {
      await Promise.all(
        slice.map(async (photoId) => {
          const stored = await readStoredFaces(env.PHOTOS, cid, photoId);
          const count = stored?.faces.length ?? 0;
          if (count === 0) return;
          await removePhotoFaces(env.FACE_INDEX!, { photoId, faceCount: count })
            .then(() => { unindexed += count; })
            .catch(() => undefined);
        }),
      );
    }

    await env.PHOTOS.delete(
      slice.flatMap((photoId) => [
        photoKey(cid, photoId),
        thumbKey(cid, photoId),
        photoMetaKey(cid, photoId),
        facesKey(cid, photoId),
      ]),
    );
    deleted += slice.length;
  }

  if (wholeCollection) {
    await env.PHOTOS.delete(`meta/collection/${cid}`).catch(() => undefined);
  }

  return json({ deleted, unindexed, collectionRemoved: wholeCollection });
}

/** Every photo id in a collection, read from the record keys. */
async function listPhotoIds(bucket: R2Bucket, cid: string): Promise<string[]> {
  const prefix = `meta/photo/${cid}/`;
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const o of page.objects) {
      const id = o.key.slice(prefix.length);
      if (isSafeId(id)) ids.push(id);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return ids;
}

/** Reads back what was detected for one photo, index or no index. */
export async function readStoredFaces(
  bucket: R2Bucket,
  cid: string,
  photoId: string,
): Promise<StoredFaces | null> {
  const obj = await bucket.get(facesKey(cid, photoId));
  if (!obj) return null;
  try {
    return await obj.json<StoredFaces>();
  } catch {
    return null;
  }
}
