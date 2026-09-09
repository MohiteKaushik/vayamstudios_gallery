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
import type { R2Bucket } from "./storage.server.ts";

export type MediaEnv = {
  PHOTOS: R2Bucket;
  SESSION_SECRET?: string;
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
