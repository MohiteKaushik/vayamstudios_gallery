/**
 * Every record in the product, kept in R2 and nothing else.
 *
 * R2 is object storage, not a database: no queries, no joins, no transactions.
 * That is workable here only because of how the writes fall out. Look at who
 * writes what:
 *
 *   a photo record      written once, by one admin, at upload
 *   a collection record written by an admin, rarely
 *   a member record     written by that member alone
 *   a scan result       written by that member alone, for that collection
 *
 * No two actors ever write the same key, so the absence of transactions costs
 * nothing. Two hundred members scanning at once touch two hundred separate
 * objects. If that ever stops being true, the write in question needs a
 * conditional put with an etag, not a bigger machine.
 *
 * Listing replaces the queries a database would have run. R2 lists by key
 * prefix, so keys are laid out to make the two listings the product needs cheap:
 * all collections, and one collection's photos in pages.
 *
 * The scan result is deliberately fat. It stores the width, height and filename
 * of every matched photo alongside the ids, so reopening a collection is a
 * single GET rather than several hundred. That one decision is most of what
 * keeps retrieval inside the five second budget.
 */

/** The subset of R2Bucket this module uses. Kept local so the types are honest. */
export type R2Bucket = {
  get: (key: string) => Promise<R2Object | null>;
  put: (key: string, value: ArrayBuffer | ReadableStream | string, options?: R2PutOptions) => Promise<unknown>;
  delete: (keys: string | string[]) => Promise<void>;
  list: (options?: R2ListOptions) => Promise<R2Listing>;
  head: (key: string) => Promise<R2Object | null>;
};

type R2Object = {
  key: string;
  size: number;
  etag: string;
  httpEtag: string;
  uploaded: Date;
  body: ReadableStream;
  arrayBuffer: () => Promise<ArrayBuffer>;
  text: () => Promise<string>;
  json: <T>() => Promise<T>;
  writeHttpMetadata: (headers: Headers) => void;
};

type R2PutOptions = {
  httpMetadata?: { contentType?: string; cacheControl?: string };
  customMetadata?: Record<string, string>;
  /**
   * Conditional write. `etagDoesNotMatch: "*"` means "only if nothing is here",
   * which is how a key is claimed safely without transactions.
   */
  onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
};

type R2ListOptions = {
  prefix?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
  delimiter?: string | undefined;
};
type R2Listing = { objects: R2Object[]; truncated: boolean; cursor?: string };

// ---------------------------------------------------------------------------
// Key layout. Every key is derived, never stored, so nothing can drift.
// ---------------------------------------------------------------------------

export const keys = {
  photo: (cid: string, photoId: string) => `photo/${cid}/${photoId}`,
  thumb: (cid: string, photoId: string) => `thumb/${cid}/${photoId}`,
  photoMeta: (cid: string, photoId: string) => `meta/photo/${cid}/${photoId}`,
  photoMetaPrefix: (cid: string) => `meta/photo/${cid}/`,
  collection: (cid: string) => `meta/collection/${cid}`,
  collectionPrefix: () => `meta/collection/`,
  member: (userId: string) => `meta/member/${userId}`,
  scan: (userId: string, cid: string) => `scan/${userId}/${cid}`,
};

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export type MemberRecord = {
  id: string;
  email: string;
  displayName: string | null;
  role: "admin" | "member";
  onboarded: boolean;
  /**
   * The member's face, as one or more embeddings. Starts as the single
   * enrolment selfie and grows, without the member doing anything, as scans
   * confirm them at angles the selfie did not cover.
   */
  references: number[][];
  referenceImageKey: string | null;
  createdAt: number;
};

export type PhotoRecord = {
  id: string;
  collectionId: string;
  fileName: string;
  width: number;
  height: number;
  facesCount: number;
  /** Face boxes for the overlay, in stored-image pixels, one per indexed face. */
  boxes: { x: number; y: number; width: number; height: number }[];
  uploadedBy: string;
  createdAt: number;
};

export type CollectionRecord = {
  id: string;
  name: string;
  description: string | null;
  coverPhotoId: string | null;
  createdBy: string;
  createdAt: number;
};

/** One matched photo, carrying enough to render the grid with no further reads. */
export type ScanHit = {
  photoId: string;
  distance: number;
  /** 0 when matched straight off the member's own reference, higher when reached through the face graph. */
  hops: number;
  fileName: string;
  width: number;
  height: number;
};

export type ScanRecord = {
  userId: string;
  collectionId: string;
  hits: ScanHit[];
  truncated: boolean;
  scannedAt: number;
  /** Kept so a stale scan can be spotted after an admin adds photos. */
  collectionPhotoCount: number;
};

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const obj = await bucket.get(key);
  if (!obj) return null;
  try {
    return await obj.json<T>();
  } catch {
    return null;
  }
}

async function writeJson(bucket: R2Bucket, key: string, value: unknown): Promise<void> {
  await bucket.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
  });
}

/**
 * Runs reads in bounded parallel batches. Sequential reads are what would blow
 * the latency budget when a member matches four hundred photos.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  job: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(job))));
  }
  return out;
}

/** Parallel reads in flight at once. R2 is fast; the cap is about being a good citizen. */
export const READ_CONCURRENCY = 40;

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export const getMember = (b: R2Bucket, userId: string) =>
  readJson<MemberRecord>(b, keys.member(userId));

export const putMember = (b: R2Bucket, m: MemberRecord) =>
  writeJson(b, keys.member(m.id), m);

export async function isAdmin(b: R2Bucket, userId: string): Promise<boolean> {
  const m = await getMember(b, userId);
  return m?.role === "admin";
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export const getCollection = (b: R2Bucket, cid: string) =>
  readJson<CollectionRecord>(b, keys.collection(cid));

export const putCollection = (b: R2Bucket, c: CollectionRecord) =>
  writeJson(b, keys.collection(c.id), c);

/** Lists every collection. There are tens of these, not thousands. */
export async function listCollections(b: R2Bucket): Promise<CollectionRecord[]> {
  const found: CollectionRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await b.list({ prefix: keys.collectionPrefix(), cursor, limit: 1000 });
    const records = await mapLimit(page.objects, READ_CONCURRENCY, (o) =>
      readJson<CollectionRecord>(b, o.key),
    );
    for (const r of records) if (r) found.push(r);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return found.sort((a, z) => z.createdAt - a.createdAt);
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

export const getPhoto = (b: R2Bucket, cid: string, photoId: string) =>
  readJson<PhotoRecord>(b, keys.photoMeta(cid, photoId));

export const putPhoto = (b: R2Bucket, p: PhotoRecord) =>
  writeJson(b, keys.photoMeta(p.collectionId, p.id), p);

/** One page of a collection's photos, for the admin grid. */
export async function listPhotos(
  b: R2Bucket,
  cid: string,
  opts: { cursor?: string; limit?: number } = {},
): Promise<{ photos: PhotoRecord[]; cursor?: string }> {
  const page = await b.list({
    prefix: keys.photoMetaPrefix(cid),
    ...(opts.cursor === undefined ? {} : { cursor: opts.cursor }),
    limit: opts.limit ?? 120,
  });
  const records = await mapLimit(page.objects, READ_CONCURRENCY, (o) =>
    readJson<PhotoRecord>(b, o.key),
  );
  const photos = records.filter((r): r is PhotoRecord => r !== null);
  photos.sort((a, z) => z.createdAt - a.createdAt);
  return page.truncated && page.cursor ? { photos, cursor: page.cursor } : { photos };
}

/** Total photos in a collection. Counts keys without reading their bodies. */
export async function countPhotos(b: R2Bucket, cid: string): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  do {
    const page = await b.list({ prefix: keys.photoMetaPrefix(cid), cursor, limit: 1000 });
    total += page.objects.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return total;
}

/** Deletes a photo and everything derived from it. The face index is cleared separately. */
export async function deletePhoto(b: R2Bucket, cid: string, photoId: string): Promise<void> {
  await b.delete([
    keys.photo(cid, photoId),
    keys.thumb(cid, photoId),
    keys.photoMeta(cid, photoId),
  ]);
}

// ---------------------------------------------------------------------------
// Scan results
// ---------------------------------------------------------------------------

export const getScan = (b: R2Bucket, userId: string, cid: string) =>
  readJson<ScanRecord>(b, keys.scan(userId, cid));

export const putScan = (b: R2Bucket, s: ScanRecord) =>
  writeJson(b, keys.scan(s.userId, s.collectionId), s);

/**
 * Turns raw index matches into a scan record the grid can render on its own.
 *
 * The metadata reads happen once, here, and are folded into the stored result.
 * Every later view of the collection costs a single GET no matter how many
 * photos matched.
 */
export async function buildScanRecord(
  b: R2Bucket,
  args: {
    userId: string;
    collectionId: string;
    matches: { photoId: string; distance: number; hops: number }[];
    truncated: boolean;
    collectionPhotoCount: number;
  },
): Promise<ScanRecord> {
  const records = await mapLimit(args.matches, READ_CONCURRENCY, async (m) => {
    const photo = await getPhoto(b, args.collectionId, m.photoId);
    if (!photo) return null;
    return {
      photoId: m.photoId,
      distance: m.distance,
      hops: m.hops,
      fileName: photo.fileName,
      width: photo.width,
      height: photo.height,
    } satisfies ScanHit;
  });

  return {
    userId: args.userId,
    collectionId: args.collectionId,
    hits: records.filter((h): h is ScanHit => h !== null),
    truncated: args.truncated,
    scannedAt: Date.now(),
    collectionPhotoCount: args.collectionPhotoCount,
  };
}

// ---------------------------------------------------------------------------
// Serving image bytes
// ---------------------------------------------------------------------------

/**
 * Streams a photo out of R2 behind the caller's own authorisation check.
 *
 * The long max-age is safe because keys are immutable: a photo id is minted
 * once and its bytes never change. `private` keeps it in the member's browser
 * rather than a shared cache, since collections are not public.
 */
export async function serveImage(
  b: R2Bucket,
  key: string,
  req: Request,
): Promise<Response> {
  const object = await b.get(key);
  if (!object) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, max-age=31536000, immutable");

  // A revisited photo costs no R2 read and no bandwidth.
  if (req.headers.get("if-none-match") === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(object.body, { headers });
}
