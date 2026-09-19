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
  /** Google OAuth web client id, for Sign in with Google. */
  GOOGLE_CLIENT_ID?: string;
  /** Google OAuth web client secret, for exchanging the callback code. */
  GOOGLE_CLIENT_SECRET?: string;
  /** Optional exact OAuth redirect URI registered in Google Cloud. */
  GOOGLE_REDIRECT_URI?: string;
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
  /** For duplicate detection, see duplicates.ts. Set the first time the console looks. */
  fingerprint?: string;
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
  if (kind === "face") return handleFacePhoto(request, env, rest);

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

/* -------------------------------------------------------------------------- */
/*                          The member's own reference                        */
/* -------------------------------------------------------------------------- */

/**
 * A small crop of the face a member enrolled with.
 *
 * This is stored, and it is the one place a photograph of a member is. It was
 * added because of what the console is for: the waiting list exists so the team
 * can go and photograph the people who have not been photographed yet, and a
 * name and a phone number do not let anyone pick a person out of a crowded
 * room. A face does.
 *
 * It is deliberately small, roughly a 320 pixel square of head and shoulders
 * rather than the selfie itself, and it is readable only by the member it
 * belongs to and by an operator. It is deleted the moment the member removes
 * their face profile.
 *
 * Everything the app says about this had to change with it. The sign-in screen
 * used to promise that face data never leaves the device, and that is no longer
 * true, so it no longer says it.
 */
export const facePhotoKey = (userId: string) => `meta/face-photo/${userId}`;

/** The most a reference crop may be. A 320px JPEG is a small fraction of this. */
const MAX_FACE_PHOTO_BYTES = 400_000;

async function handleFacePhoto(
  request: Request,
  env: MediaEnv,
  rest: string[],
): Promise<Response> {
  const userId = await currentUserId(request, env);
  if (!userId) return json({ error: "Not signed in" }, 401);

  if (request.method === "POST") {
    const contentType = (request.headers.get("content-type") ?? "").split(";")[0]!.trim();
    if (contentType !== "image/jpeg") return json({ error: "Send a JPEG" }, 415);

    const bytes = await request.arrayBuffer();
    if (bytes.byteLength === 0) return json({ error: "Empty upload" }, 400);
    if (bytes.byteLength > MAX_FACE_PHOTO_BYTES) return json({ error: "That crop is too large" }, 413);

    // A member may only ever write their own. The id is taken from the session,
    // never from the request, so there is nothing to forge.
    await env.PHOTOS.put(facePhotoKey(userId), bytes, {
      httpMetadata: { contentType: "image/jpeg", cacheControl: "private, max-age=300" },
    });
    return json({ ok: true }, 201);
  }

  if (request.method === "GET") {
    const wanted = rest[0] ?? userId;
    if (!isSafeId(wanted)) return new Response("Not found", { status: 404 });

    // Your own, always. Anyone else's, only an operator, because this is the
    // one route in the app that hands over a photograph of a person's face.
    if (wanted !== userId) {
      const member = await getMemberById(env.PHOTOS, userId);
      if (!member || member.role !== "admin") {
        return new Response("Not allowed", { status: 403 });
      }
    }
    return serveObject(env.PHOTOS, facePhotoKey(wanted), request);
  }

  return new Response("Method not allowed", { status: 405 });
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
  /** Specific photos, or omitted to delete the whole event. */
  photos?: string[];
  /**
   * A recycle bin entry this request adds to. A large selection goes up in
   * slices, and every slice after the first names the entry the first one
   * made, so the whole selection comes back with one Restore.
   */
  groupId?: string;
};

/**
 * Deleting, from the console.
 *
 * Nothing here erases anything. Photos and events go to the recycle bin below,
 * and only emptying the bin removes them for good.
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

  try {
    if (!Array.isArray(body.photos)) {
      const r = await trashEvent(env, { collectionId: cid, userId });
      return json({ deleted: r.photoCount, collectionRemoved: true, groupId: r.groupId });
    }

    const photoIds = body.photos.filter(isSafeId);
    if (photoIds.length === 0) return json({ error: "No photos named" }, 400);
    if (photoIds.length > MAX_TRASH_BATCH) {
      return json({ error: `At most ${MAX_TRASH_BATCH} photos per request` }, 413);
    }
    const r = await trashPhotos(env, {
      collectionId: cid,
      photoIds,
      userId,
      ...(body.groupId ? { groupId: body.groupId } : {}),
    });
    return json({ deleted: r.moved, collectionRemoved: false, groupId: r.groupId });
  } catch (e) {
    if (e instanceof BinError) return json({ error: e.message }, e.status);
    throw e;
  }
}

/* -------------------------------------------------------------------------- */
/*                                 Recycle bin                                */
/* -------------------------------------------------------------------------- */

/**
 * Deleting moves things to the recycle bin; only the bin deletes for good.
 *
 * LAYOUT
 *
 *   trash/group/{entry}               one entry: what went, from where, when, by whom
 *   trash/photo/{collection}/{photo}  a photo's record while it is in the bin
 *   trash/faces/{collection}/{photo}  its faces, kept so a restore can re-index them
 *   trash/collection/{collection}     an event's record, when the whole event went
 *
 * The images never move. photo/ and thumb/ stay exactly where they are until an
 * entry is emptied, which is what makes a restore instant and free: whether a
 * photograph is in the gallery or in the bin depends only on which record
 * exists for it.
 *
 * A deleted photo leaves the face search at once. A search must not return
 * something an operator removed, and its faces are kept beside it so that a
 * restore puts them straight back.
 *
 * A deleted event moves as one piece: its record goes to the bin and nothing
 * else is touched, so an event of any size is deleted and restored in a single
 * request. Nobody can reach its photos meanwhile, because every route that
 * lists or searches an event's photos checks that the event exists first.
 *
 * Anything in the bin longer than BIN_RETENTION_MS is removed for good, by a
 * daily scheduled run and again whenever the bin is opened.
 */

/**
 * How long something deleted can be brought back.
 *
 * Thirty days rather than ten. A photograph in the bin costs exactly what it
 * cost in the gallery the day before, a fraction of a rupee a month at these
 * volumes, and a duplicate batch is the kind of mistake that surfaces when
 * someone goes through an event the following week rather than the same night.
 */
export const BIN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Photos moved to the bin per request. Moving one costs several storage calls. */
export const MAX_TRASH_BATCH = 100;

export type BinGroup = {
  /** Home-page event hidden when these albums were deleted together. */
  showcaseEventId?: string;
  id: string;
  kind: "photos" | "event";
  collectionId: string;
  collectionName: string;
  /** For a "photos" entry, the photos still in the bin. Empty for an event. */
  photoIds: string[];
  /** For an "event" entry, how many photos the event held when it went. */
  photoCount: number;
  deletedAt: number;
  deletedBy: string;
  expiresAt: number;
};

export type BinPhoto = {
  id: string;
  fileName: string;
  width: number;
  height: number;
  createdAt: number;
  thumbUrl: string;
  fullUrl: string;
};

/** A refusal the console should show as it is, with the status to send. */
export class BinError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const trashGroupKey = (id: string) => `trash/group/${id}`;
const trashPhotoKey = (cid: string, photoId: string) => `trash/photo/${cid}/${photoId}`;
const trashFacesKey = (cid: string, photoId: string) => `trash/faces/${cid}/${photoId}`;
const trashCollectionKey = (cid: string) => `trash/collection/${cid}`;
const collectionRecordKey = (cid: string) => `meta/collection/${cid}`;

/** Entry ids sort newest first: an inverted timestamp, then a random id. */
const BIN_ID = /^\d{13}-[0-9a-f-]{36}$/;
export const isBinId = (id: string) => BIN_ID.test(id);
const newBinId = (now: number) =>
  `${String(9_999_999_999_999 - now).padStart(13, "0")}-${crypto.randomUUID()}`;

async function readRecord<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const obj = await bucket.get(key);
  if (!obj) return null;
  try {
    return await obj.json<T>();
  } catch {
    return null;
  }
}

const writeRecord = (bucket: R2Bucket, key: string, value: unknown) =>
  bucket.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
  });

/** Runs a job over items a few at a time. */
async function inBatches<T>(items: readonly T[], size: number, job: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(job));
  }
}

async function listKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const o of page.objects) keys.push(o.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

export async function readBinGroup(env: MediaEnv, id: string): Promise<BinGroup | null> {
  return isBinId(id) ? readRecord<BinGroup>(env.PHOTOS, trashGroupKey(id)) : null;
}

async function readAllGroups(env: MediaEnv): Promise<BinGroup[]> {
  const keys = await listKeys(env.PHOTOS, "trash/group/");
  const groups: BinGroup[] = [];
  await inBatches(keys, 25, async (key) => {
    const group = await readRecord<BinGroup>(env.PHOTOS, key);
    if (group) groups.push(group);
  });
  return groups.sort((a, b) => b.deletedAt - a.deletedAt);
}

/**
 * Moves photos to the bin.
 *
 * Each photo's record is copied into the bin before the original is removed,
 * so a request that dies half way leaves some photos in the gallery and some in
 * the bin, and never a photo in neither.
 */
export async function trashPhotos(
  env: MediaEnv,
  args: { collectionId: string; photoIds: string[]; userId: string; groupId?: string; now?: number },
): Promise<{ groupId: string | null; moved: number }> {
  const cid = args.collectionId;
  const now = args.now ?? Date.now();

  let group: BinGroup | null = null;
  if (args.groupId) {
    group = await readBinGroup(env, args.groupId);
    if (!group || group.kind !== "photos" || group.collectionId !== cid) {
      throw new BinError("That recycle bin entry does not belong to these photos", 400);
    }
  }

  const moved: string[] = [];
  await inBatches(args.photoIds, 25, async (photoId) => {
    const meta = await readRecord<PhotoMeta>(env.PHOTOS, photoMetaKey(cid, photoId));
    if (!meta) return;
    const faces = await readStoredFaces(env.PHOTOS, cid, photoId);

    await writeRecord(env.PHOTOS, trashPhotoKey(cid, photoId), meta);
    if (faces) await writeRecord(env.PHOTOS, trashFacesKey(cid, photoId), faces);

    if (faces?.faces.length && env.FACE_INDEX) {
      await removePhotoFaces(env.FACE_INDEX, { photoId, faceCount: faces.faces.length }).catch(
        () => undefined,
      );
    }
    await env.PHOTOS.delete([photoMetaKey(cid, photoId), facesKey(cid, photoId)]);
    moved.push(photoId);
  });

  if (moved.length === 0 && !group) return { groupId: null, moved: 0 };

  if (group) {
    group = { ...group, photoIds: [...new Set([...group.photoIds, ...moved])] };
  } else {
    const collection = await readRecord<{ name?: string }>(env.PHOTOS, collectionRecordKey(cid));
    group = {
      id: newBinId(now),
      kind: "photos",
      collectionId: cid,
      collectionName: collection?.name ?? "Event",
      photoIds: moved,
      photoCount: 0,
      deletedAt: now,
      deletedBy: args.userId,
      expiresAt: now + BIN_RETENTION_MS,
    };
  }
  await writeRecord(env.PHOTOS, trashGroupKey(group.id), group);
  return { groupId: group.id, moved: moved.length };
}

/** Moves a whole event to the bin in one step. Only its record moves. */
export async function trashEvent(
  env: MediaEnv,
  args: { collectionId: string; userId: string; now?: number; showcaseEventId?: string },
): Promise<{ groupId: string; photoCount: number }> {
  const cid = args.collectionId;
  const now = args.now ?? Date.now();
  const record = await readRecord<{ name?: string }>(env.PHOTOS, collectionRecordKey(cid));
  if (!record) throw new BinError("Unknown event", 404);

  const photoCount = (await listKeys(env.PHOTOS, `meta/photo/${cid}/`)).length;
  const group: BinGroup = {
    id: newBinId(now),
    kind: "event",
    ...(args.showcaseEventId ? { showcaseEventId: args.showcaseEventId } : {}),
    collectionId: cid,
    collectionName: record.name ?? "Event",
    photoIds: [],
    photoCount,
    deletedAt: now,
    deletedBy: args.userId,
    expiresAt: now + BIN_RETENTION_MS,
  };

  await writeRecord(env.PHOTOS, trashCollectionKey(cid), record);
  await writeRecord(env.PHOTOS, trashGroupKey(group.id), group);
  await env.PHOTOS.delete(collectionRecordKey(cid));
  return { groupId: group.id, photoCount };
}

/** Everything in the bin, newest first, each with a few photos to recognise it by. */
export async function listBin(env: MediaEnv): Promise<(BinGroup & { preview: BinPhoto[] })[]> {
  const groups = await readAllGroups(env);
  return Promise.all(groups.map(async (group) => ({ ...group, preview: await binPhotos(env, group, 8) })));
}

/** The photos in one entry, newest first, or the first `limit` of them. */
export async function binPhotos(env: MediaEnv, group: BinGroup, limit?: number): Promise<BinPhoto[]> {
  const cid = group.collectionId;
  let ids: string[];
  let recordKey: (photoId: string) => string;

  if (group.kind === "photos") {
    ids = limit ? group.photoIds.slice(0, limit) : group.photoIds;
    recordKey = (photoId) => trashPhotoKey(cid, photoId);
  } else {
    const prefix = `meta/photo/${cid}/`;
    ids = limit
      ? (await env.PHOTOS.list({ prefix, limit })).objects.map((o) => o.key.slice(prefix.length))
      : await listPhotoIds(env.PHOTOS, cid);
    recordKey = (photoId) => photoMetaKey(cid, photoId);
  }

  const photos: BinPhoto[] = [];
  await inBatches(ids, 50, async (photoId) => {
    const meta = await readRecord<PhotoMeta>(env.PHOTOS, recordKey(photoId));
    if (!meta) return;
    photos.push({
      id: meta.id,
      fileName: meta.fileName,
      width: meta.width,
      height: meta.height,
      createdAt: meta.createdAt,
      thumbUrl: mediaUrl(cid, meta.id, "t"),
      fullUrl: mediaUrl(cid, meta.id),
    });
  });
  return photos.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Brings an entry back, or only the photos named from it.
 *
 * A photo goes back to the gallery only after its faces are back in the search,
 * so there is no moment where a member could open the event, see the photo, and
 * fail to find themselves in it.
 */
export async function restoreFromBin(
  env: MediaEnv,
  groupId: string,
  only?: string[],
): Promise<{ restored: number; remaining: number; collectionId: string }> {
  const group = await readBinGroup(env, groupId);
  if (!group) throw new BinError("That item is no longer in the recycle bin", 404);
  const cid = group.collectionId;

  if (group.kind === "event") {
    const record = await readRecord<unknown>(env.PHOTOS, trashCollectionKey(cid));
    if (record) {
      await writeRecord(env.PHOTOS, collectionRecordKey(cid), record);
      await env.PHOTOS.delete(trashCollectionKey(cid));
    } else if (!(await env.PHOTOS.head(collectionRecordKey(cid)))) {
      throw new BinError(`"${group.collectionName}" cannot be restored because its record is missing`, 409);
    }
    if (group.showcaseEventId) {
      const key = `site/recent-events/${group.showcaseEventId}`;
      const setting = await readRecord<Record<string, unknown>>(env.PHOTOS, key);
      await writeRecord(env.PHOTOS, key, { ...setting, deleted: false });
    }
    await env.PHOTOS.delete(trashGroupKey(group.id));
    return { restored: group.photoCount, remaining: 0, collectionId: cid };
  }

  if (!(await env.PHOTOS.head(collectionRecordKey(cid)))) {
    const eventInBin = await env.PHOTOS.head(trashCollectionKey(cid));
    throw new BinError(
      eventInBin
        ? `"${group.collectionName}" is in the recycle bin too. Restore the event first.`
        : `"${group.collectionName}" no longer exists, so these photos have nowhere to go back to.`,
      409,
    );
  }

  const wanted = only ? new Set(only) : null;
  const targets = wanted ? group.photoIds.filter((id) => wanted.has(id)) : group.photoIds;
  const settled = new Set<string>();
  let restored = 0;

  await inBatches(targets, 25, async (photoId) => {
    const meta = await readRecord<PhotoMeta>(env.PHOTOS, trashPhotoKey(cid, photoId));
    if (!meta) {
      // Already gone from the bin, so it leaves the entry either way.
      settled.add(photoId);
      return;
    }
    const faces = await readRecord<StoredFaces>(env.PHOTOS, trashFacesKey(cid, photoId));
    if (faces) {
      let indexedAt: number | null = null;
      const descriptors = faces.faces.map((f) => f.descriptor);
      if (env.FACE_INDEX && descriptors.length > 0 && descriptors.every((d) => d.length === DESCRIPTOR_DIM)) {
        const r = await indexPhotoFaces(env.FACE_INDEX, { collectionId: cid, photoId, descriptors }).catch(
          () => ({ indexed: 0 }),
        );
        if (r.indexed > 0) indexedAt = Date.now();
      }
      await writeRecord(env.PHOTOS, facesKey(cid, photoId), { ...faces, indexedAt });
    }
    await writeRecord(env.PHOTOS, photoMetaKey(cid, photoId), meta);
    await env.PHOTOS.delete([trashPhotoKey(cid, photoId), trashFacesKey(cid, photoId)]);
    settled.add(photoId);
    restored++;
  });

  const remaining = group.photoIds.filter((id) => !settled.has(id));
  if (remaining.length > 0) {
    await writeRecord(env.PHOTOS, trashGroupKey(group.id), { ...group, photoIds: remaining });
  } else {
    await env.PHOTOS.delete(trashGroupKey(group.id));
  }
  return { restored, remaining: remaining.length, collectionId: cid };
}

/** Removes photographs for good: images, records, and any faces still in the search. */
async function erasePhotos(env: MediaEnv, cid: string, ids: string[], from: "gallery" | "bin") {
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100);
    if (from === "gallery" && env.FACE_INDEX) {
      await Promise.all(
        slice.map(async (photoId) => {
          const stored = await readStoredFaces(env.PHOTOS, cid, photoId);
          const count = stored?.faces.length ?? 0;
          if (count > 0) {
            await removePhotoFaces(env.FACE_INDEX!, { photoId, faceCount: count }).catch(() => undefined);
          }
        }),
      );
    }
    await env.PHOTOS.delete(
      slice.flatMap((photoId) =>
        from === "gallery"
          ? [photoKey(cid, photoId), thumbKey(cid, photoId), photoMetaKey(cid, photoId), facesKey(cid, photoId)]
          : [photoKey(cid, photoId), thumbKey(cid, photoId), trashPhotoKey(cid, photoId), trashFacesKey(cid, photoId)],
      ),
    );
  }
}

/** Empties an entry, or only the photos named from it. There is no undoing this. */
export async function deleteForever(
  env: MediaEnv,
  groupId: string,
  only?: string[],
): Promise<{ deleted: number; remaining: number }> {
  const group = await readBinGroup(env, groupId);
  if (!group) throw new BinError("That item is no longer in the recycle bin", 404);
  const cid = group.collectionId;

  if (group.kind === "event") {
    // Restored since from another tab: the event is live, so only the stale entry goes.
    if (await env.PHOTOS.head(collectionRecordKey(cid))) {
      await env.PHOTOS.delete(trashGroupKey(group.id));
      return { deleted: 0, remaining: 0 };
    }
    const ids = await listPhotoIds(env.PHOTOS, cid);
    await erasePhotos(env, cid, ids, "gallery");

    // Photos deleted from this event earlier sit in entries of their own. With
    // the event gone for good they have nowhere to return to, so they go too.
    for (const other of await readAllGroups(env)) {
      if (other.kind === "photos" && other.collectionId === cid) {
        await erasePhotos(env, cid, other.photoIds, "bin");
        await env.PHOTOS.delete(trashGroupKey(other.id));
      }
    }
    const waiting = await listKeys(env.PHOTOS, `waiting/${cid}/`);
    await env.PHOTOS.delete([trashCollectionKey(cid), trashGroupKey(group.id), ...waiting]);
    return { deleted: ids.length, remaining: 0 };
  }

  const wanted = only ? new Set(only) : null;
  const targets = wanted ? group.photoIds.filter((id) => wanted.has(id)) : group.photoIds;
  await erasePhotos(env, cid, targets, "bin");

  const gone = new Set(targets);
  const remaining = group.photoIds.filter((id) => !gone.has(id));
  if (remaining.length > 0) {
    await writeRecord(env.PHOTOS, trashGroupKey(group.id), { ...group, photoIds: remaining });
  } else {
    await env.PHOTOS.delete(trashGroupKey(group.id));
  }
  return { deleted: targets.length, remaining: remaining.length };
}

/** Clears every entry older than BIN_RETENTION_MS. Returns how many went. */
export async function purgeExpired(env: MediaEnv, now = Date.now()): Promise<number> {
  let purged = 0;
  for (const group of await readAllGroups(env)) {
    if (group.expiresAt > now) continue;
    try {
      await deleteForever(env, group.id);
      purged++;
    } catch (e) {
      // Already cleared along with its event earlier in this same pass.
      if (!(e instanceof BinError && e.status === 404)) console.error(`[bin] could not clear ${group.id}`, e);
    }
  }
  return purged;
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
