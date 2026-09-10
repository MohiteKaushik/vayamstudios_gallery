/**
 * The product's data API, reading and writing R2 only.
 *
 * WHY THIS EXISTS
 *
 * Uploads already went to R2 while every list in the interface still queried
 * the old database. Photos were stored correctly and the grid showed nothing,
 * because it was asking a table nothing writes to any more. This is the other
 * half: collections, photos, face profiles and scanning, all from R2.
 *
 * WHERE THINGS LIVE
 *
 *   meta/collection/{c}          the collection record
 *   meta/photo/{c}/{p}           one photo's record
 *   meta/faces/{c}/{p}           its faces, boxes and descriptors
 *   meta/member/{u}              the member, including their reference faces
 *   scan/{u}/{c}                 a member's results for one collection
 *
 * WHY A SCAN RESULT IS STORED FAT
 *
 * The cached result carries each matched photo's filename and dimensions, not
 * just its id. Reopening a collection is then a single read however many photos
 * matched, instead of one read per photo. That single decision is most of what
 * keeps reopening under a second.
 */

import {
  currentUserId,
  isSafeId,
  photoMetaKey,
  facesKey,
  mediaUrl,
  DESCRIPTOR_DIM,
  type MediaEnv,
  type PhotoMeta,
} from "./media.server.ts";
import {
  getMemberById,
  getMemberByEmail,
  putMember,
  toPublicMember,
  createMember,
  authenticate,
  ensureRole,
  type MemberRecord,
} from "./auth/members.server.ts";
import {
  createSessionToken,
  sessionCookieHeader,
  clearSessionCookieHeader,
  isSecureRequest,
} from "./auth/session.ts";
import { hashPassword } from "./auth/password.ts";
import { validateSignUp } from "./members.ts";
import { searchCollection, indexPhotoFaces } from "./face-index.server.ts";
import { MATCH_MAX_DISTANCE } from "./face.ts";
import { cosineDistance } from "./insightface.ts";
import type { R2Bucket } from "./storage.server.ts";

export const API_PREFIX = "/api";

export type CollectionRecord = {
  id: string;
  name: string;
  description: string | null;
  coverPhotoId: string | null;
  createdBy: string;
  createdAt: number;
};

export type ScanHit = {
  photoId: string;
  /** 0 when matched straight off a reference, higher when reached through the graph. */
  hops: number;
  /** 0 to 1. How confident the match is, calibrated below. */
  confidence: number;
  fileName: string;
  width: number;
  height: number;
  thumbUrl: string;
  fullUrl: string;
};

export type ScanRecord = {
  userId: string;
  collectionId: string;
  hits: ScanHit[];
  /** Matches below the confident threshold, offered separately rather than hidden. */
  possible: ScanHit[];
  scannedAt: number;
  facesSearched: number;
  /** Which matching settings produced this. Absent means older than the first version. */
  matcher?: number;
  /** Where the scan spent its time, in milliseconds. Absent on records written before this was measured. */
  timing?: { searchMs: number; readMs: number; statusMs: number; totalMs: number };
  /**
   * Matches whose photo record was missing, so they could not be shown.
   * Surfaced rather than swallowed: a scan that matches faces and displays
   * nothing needs a different fix from one that matched nothing.
   */
  orphaned?: number;
  /**
   * Why the result looks the way it does, so the interface can say something
   * true rather than defaulting to "no matches" for every empty outcome.
   *
   *   ok             matches were found
   *   empty          the collection has no photos
   *   not-processed  photos exist but were never run through detection
   *   no-faces       photos were processed and contain no faces at all
   *   indexing       faces exist but have not reached the search index yet
   *   no-match       everything is indexed; this member is not in these photos
   */
  state: "ok" | "empty" | "not-processed" | "no-faces" | "indexing" | "no-match";
  /** Counts behind that verdict, so an operator can act on it. */
  index?: CollectionStatus;
};

const collectionKey = (cid: string) => `meta/collection/${cid}`;
const scanKey = (userId: string, cid: string) => `scan/${userId}/${cid}`;

/**
 * Which matching settings produced a stored scan.
 *
 * A scan is cached so that reopening an event does not re-run the search, and
 * that cache outlives a deploy. When the thresholds change, every stored scan
 * becomes a set of answers from the old settings, and a member who had already
 * looked would keep seeing them: after a tightening, that means still being
 * shown the strangers the tightening was meant to remove.
 *
 * Bump this whenever a change alters which photographs come back. Older records
 * are then ignored and the next open re-runs the search. Nothing is deleted, so
 * a record written by a newer version is left alone by an older one.
 *
 *   1  threshold 0.46, graph expansion on
 *   2  threshold 0.34, expansion off, no marginal tier
 *   3  threshold 0.10, confidence read from the measured curve
 */
const MATCHER_VERSION = 4;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

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

/** Runs reads in bounded parallel batches; sequential reads blow the latency budget. */
async function mapLimit<T, R>(items: T[], limit: number, job: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(job))));
  }
  return out;
}

const READ_CONCURRENCY = 50;

/* -------------------------------------------------------------------------- */
/*                                 Confidence                                 */
/* -------------------------------------------------------------------------- */

/**
 * Turns a distance into a percentage a person can act on.
 *
 * Anchored to the photographs, not to the threshold. An earlier version tied
 * this to MATCH_MAX_DISTANCE, so whatever the threshold was, a result sitting
 * on it read 80 percent; when strangers were getting through they arrived
 * wearing 81 percent and the figure argued for them.
 *
 * These anchors come from the three live collections measured through the
 * InsightFace pack, in cosine distance between unit-length embeddings:
 *
 *   0.00  the same photograph
 *   0.17  the furthest true match in the demo collection
 *   0.39  the furthest true match in the event collection
 *   0.50  the threshold; a hard profile shot of the right person sits here
 *   0.60  the nearest genuine stranger seen in any collection
 *   0.90  where two unrelated faces typically sit
 *
 *   distance   reads as
 *   0.00        99%
 *   0.20        92%
 *   0.35        82%
 *   0.50        70%      a real match, at an awkward angle
 *   0.60        45%
 *   0.75        15%
 *   0.90+        3%
 *
 * The curve stays generous inside the threshold and falls off a cliff just
 * past it, which is the shape the measurements actually have: below 0.5 nearly
 * everything was the right person, and by 0.6 it was not.
 */
const CONFIDENCE_CURVE: readonly (readonly [number, number])[] = [
  [0.0, 0.99],
  [0.2, 0.92],
  [0.35, 0.82],
  [0.5, 0.7],
  [0.6, 0.45],
  [0.75, 0.15],
  [0.9, 0.03],
  [2.0, 0.0],
];

/** Kept for the tiering below and for anything that still reads it. */
export const CERTAIN_DISTANCE = 0.2;

/**
 * The bar a result must clear to be shown at all.
 *
 * Read against the curve above rather than against the threshold, so it means
 * a fixed level of evidence. At the current match distance everything admitted
 * clears it; loosen the match distance and this is what stops weak results
 * reaching a member.
 */
export const CONFIDENT_THRESHOLD = 0.4;

/**
 * Hops are evidence too, and weaker evidence than a direct match.
 *
 * Nothing produces hops while the graph expansion is off, but the penalty
 * stands so that a linked face never reads as confidently as one matched
 * straight off the member's own reference.
 */
const HOP_PENALTY = 0.06;

export function confidenceFor(distance: number, hops = 0): number {
  const d = Number.isFinite(distance) ? Math.max(0, distance) : Infinity;

  let base = 0;
  for (let i = 1; i < CONFIDENCE_CURVE.length; i++) {
    const [x0, y0] = CONFIDENCE_CURVE[i - 1]!;
    const [x1, y1] = CONFIDENCE_CURVE[i]!;
    if (d <= x1) {
      base = y0 + ((d - x0) / (x1 - x0)) * (y1 - y0);
      break;
    }
  }

  return Math.max(0, base - hops * HOP_PENALTY);
}

/* -------------------------------------------------------------------------- */

/**
 * Entry point for the data API.
 *
 * Everything is wrapped so a thrown error becomes a JSON body with a reference,
 * not an HTML error page. A 500 that says only "Request failed" is unactionable:
 * the reference here is printed in the Worker log next to the stack, so any
 * report can be traced to the exact failure.
 */
export async function handleApiRequest(
  request: Request,
  env: MediaEnv,
): Promise<Response | null> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  if (!url.pathname.startsWith(API_PREFIX + "/")) return null;

  try {
    return await route(request, env, url);
  } catch (error) {
    const reference = crypto.randomUUID().slice(0, 8);
    console.error(`[api ${reference}] ${request.method} ${url.pathname}`, error);
    return json(
      {
        error: error instanceof Error ? error.message : "Something went wrong",
        reference,
      },
      500,
    );
  }
}

async function route(request: Request, env: MediaEnv, url: URL): Promise<Response> {
  const parts = url.pathname.slice(API_PREFIX.length + 1).split("/").filter(Boolean);
  const [head, ...rest] = parts;

  // Sign-in and sign-up are the only routes reachable without a session.
  if (head === "auth") return handleAuth(request, env, rest[0] ?? "");

  const userId = await currentUserId(request, env);

  if (head === "me") {
    if (!userId) return json({ error: "Not signed in" }, 401);
    const member = await getMemberById(env.PHOTOS, userId);
    return member ? json(toPublicMember(member)) : json({ error: "No such member" }, 404);
  }

  if (!userId) return json({ error: "Not signed in" }, 401);
  const member = await getMemberById(env.PHOTOS, userId);
  if (!member) return json({ error: "No such member" }, 401);
  const isAdmin = member.role === "admin";

  if (head === "collections") {
    if (rest.length === 0 && request.method === "GET") return listCollections(env);
    if (rest.length === 0 && request.method === "POST") {
      if (!isAdmin) return json({ error: "Admins only" }, 403);
      return createCollection(request, env, userId);
    }
    const cid = rest[0] ?? "";
    if (!isSafeId(cid)) return json({ error: "Unknown collection" }, 400);
    if (rest[1] === "photos" && request.method === "GET") {
      return listPhotos(env, cid, url.searchParams.get("cursor"));
    }
    if (rest[1] === "status" && request.method === "GET") {
      return json(await collectionStatus(env, cid));
    }
    if (rest[1] === "unindexed" && request.method === "GET") {
      if (!isAdmin) return json({ error: "Admins only" }, 403);
      return json(await unindexedPhotos(env, cid));
    }
    if (rest[1] === "reindex" && request.method === "POST") {
      if (!isAdmin) return json({ error: "Admins only" }, 403);
      return reindexCollection(env, cid);
    }
    if (rest[1] === "selftest" && request.method === "POST") {
      if (!isAdmin) return json({ error: "Admins only" }, 403);
      return selfTest(env, cid);
    }
    return json({ error: "Not found" }, 404);
  }

  if (head === "members" && request.method === "GET") {
    if (!isAdmin) return json({ error: "Admins only" }, 403);
    return listMembers(env);
  }

  if (head === "waiting" && request.method === "GET") {
    if (!isAdmin) return json({ error: "Admins only" }, 403);
    return listWaiting(env);
  }

  if (head === "face-profile") {
    if (request.method === "POST") return saveFaceProfile(request, env, userId);
    if (request.method === "DELETE") return forgetFace(env, member);
  }

  if (head === "scan") {
    if (request.method === "POST") return runScan(request, env, userId);
    const cid = rest[0] ?? "";
    if (request.method === "GET" && isSafeId(cid)) {
      const cached = await readJson<ScanRecord>(env.PHOTOS, scanKey(userId, cid));
      const current = cached?.matcher === MATCHER_VERSION ? cached : null;
      return json(current ?? { hits: [], possible: [], scannedAt: 0, facesSearched: 0 });
    }
  }

  return json({ error: "Not found" }, 404);
}

/* ------------------------------- collections ------------------------------ */

async function listCollections(env: MediaEnv): Promise<Response> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.PHOTOS.list({ prefix: "meta/collection/", cursor, limit: 1000 });
    for (const o of page.objects) keys.push(o.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const records = await mapLimit(keys, READ_CONCURRENCY, (k) =>
    readJson<CollectionRecord>(env.PHOTOS, k),
  );

  // Photo counts come from counting keys, which needs no record reads.
  const collections = await mapLimit(
    records.filter((r): r is CollectionRecord => r !== null),
    10,
    async (c) => {
      const cover = c.coverPhotoId ?? (await firstPhotoId(env.PHOTOS, c.id));
      return {
        ...c,
        coverPhotoId: cover,
        photoCount: await countPhotos(env.PHOTOS, c.id),
        coverUrl: cover ? mediaUrl(c.id, cover, "t") : null,
      };
    },
  );

  collections.sort((a, b) => b.createdAt - a.createdAt);
  return json({ collections });
}

/**
 * A photograph to put on the event's card.
 *
 * coverPhotoId is set when an event is created and never written again, so it
 * was null for every event that has ever existed and every card came up blank.
 * Rather than a migration, the cover falls back to the first photograph in the
 * event, which is one listing of one key and is what an operator would have
 * picked anyway.
 */
async function firstPhotoId(bucket: R2Bucket, cid: string): Promise<string | null> {
  const prefix = `meta/photo/${cid}/`;
  const page = await bucket.list({ prefix, limit: 1 });
  const key = page.objects[0]?.key;
  if (!key) return null;
  const id = key.slice(prefix.length);
  return isSafeId(id) ? id : null;
}

/**
 * Photographs in this event that no face record covers yet.
 *
 * The uploader script has no way to look at a photograph: detection runs in a
 * browser, on a canvas, and a script pushing files from a memory card is not
 * one. So it uploads, and a console left open watches this list and indexes
 * whatever appears. That keeps the two halves independent, which matters when
 * the uploading laptop belongs to somebody else.
 *
 * Ids only. During an event this is polled every few seconds and the records
 * themselves are not needed to decide what to work on.
 */
async function unindexedPhotos(
  env: MediaEnv,
  cid: string,
): Promise<{ photoIds: string[]; total: number; indexed: number }> {
  const collect = async (prefix: string) => {
    const ids = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await env.PHOTOS.list({ prefix, cursor, limit: 1000 });
      for (const o of page.objects) {
        const id = o.key.slice(prefix.length);
        if (isSafeId(id)) ids.add(id);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return ids;
  };

  const [photos, faces] = await Promise.all([
    collect(`meta/photo/${cid}/`),
    collect(`meta/faces/${cid}/`),
  ]);

  const pending = [...photos].filter((id) => !faces.has(id));
  return { photoIds: pending, total: photos.size, indexed: faces.size };
}

async function countPhotos(bucket: R2Bucket, cid: string): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: `meta/photo/${cid}/`, cursor, limit: 1000 });
    total += page.objects.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return total;
}

async function createCollection(
  request: Request,
  env: MediaEnv,
  userId: string,
): Promise<Response> {
  let body: { name?: string; description?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "Malformed body" }, 400);
  }
  const name = (body.name ?? "").trim();
  if (!name) return json({ error: "A collection needs a name" }, 400);

  const record: CollectionRecord = {
    id: crypto.randomUUID(),
    name: name.slice(0, 120),
    description: (body.description ?? "").trim().slice(0, 400) || null,
    coverPhotoId: null,
    createdBy: userId,
    createdAt: Date.now(),
  };
  await writeJson(env.PHOTOS, collectionKey(record.id), record);
  return json(record, 201);
}

/* --------------------------------- photos --------------------------------- */

async function listPhotos(
  env: MediaEnv,
  cid: string,
  cursor: string | null,
): Promise<Response> {
  const prefix = `meta/photo/${cid}/`;
  const page = await env.PHOTOS.list({
    prefix,
    limit: 200,
    ...(cursor ? { cursor } : {}),
  });

  const records = await mapLimit(page.objects, READ_CONCURRENCY, (o) =>
    readJson<PhotoMeta>(env.PHOTOS, o.key),
  );

  const photos = records
    .filter((p): p is PhotoMeta => p !== null)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((p) => ({
      id: p.id,
      fileName: p.fileName,
      width: p.width,
      height: p.height,
      facesCount: p.facesCount,
      thumbUrl: mediaUrl(cid, p.id, "t"),
      fullUrl: mediaUrl(cid, p.id),
    }));

  return json({
    photos,
    ...(page.truncated && page.cursor ? { cursor: page.cursor } : {}),
  });
}

/* ---------------------------------- auth ---------------------------------- */

/**
 * Sign-up, sign-in and sign-out, on this Worker and nowhere else.
 *
 * Passwords are hashed with PBKDF2 through WebCrypto and sessions are signed
 * cookies; both are covered by their own test suites. Nothing here talks to an
 * outside service, which is the point: two identity systems disagreeing about
 * who someone is caused every confusing permission error in this app.
 */
async function handleAuth(request: Request, env: MediaEnv, action: string): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!env.SESSION_SECRET) return json({ error: "SESSION_SECRET is not configured" }, 500);

  const secure = isSecureRequest(request);

  if (action === "signout") {
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        "content-type": "application/json",
        "set-cookie": clearSessionCookieHeader({ secure }),
      },
    });
  }

  let body: { email?: string; password?: string; fullName?: string; phone?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "Malformed body" }, 400);
  }

  const email = (body.email ?? "").trim();
  const password = body.password ?? "";
  if (!email || !password) return json({ error: "Email and password are required" }, 400);

  if (action === "signup") {
    const errors = validateSignUp({
      fullName: body.fullName ?? "",
      phone: body.phone ?? "",
      email,
      password,
    });
    if (Object.keys(errors).length > 0) return json({ error: "Check the form", errors }, 400);

    const created = await createMember(env.PHOTOS, {
      email,
      password,
      fullName: body.fullName ?? "",
      phone: body.phone ?? "",
    });
    if (!created.ok) {
      return created.error === "email-taken"
        ? json({ error: "An account already uses that email" }, 409)
        : json({ error: "Could not create the account" }, 500);
    }
    const member = await ensureRole(env.PHOTOS, created.member, env.ADMIN_EMAIL);
    return signedIn(member, env.SESSION_SECRET, secure);
  }

  if (action === "signin") {
    // The operator credentials in the environment are the authority for the
    // console account. If they match, the account is created when missing and
    // its stored password is brought into line when it is not.
    //
    // That second case matters: accounts left behind by the old migration hold
    // a deliberately unusable password, so without this the operator could
    // never sign in to their own console again. Only the configured address
    // with the configured password reaches this, so it cannot be used to claim
    // anyone else's account.
    const adminEmail = env.ADMIN_EMAIL?.trim().toLowerCase();
    const adminPassword = env.ADMIN_PASSWORD;
    if (
      adminEmail &&
      adminPassword &&
      email.toLowerCase() === adminEmail &&
      password === adminPassword
    ) {
      const existing = await getMemberByEmail(env.PHOTOS, email);
      if (!existing) {
        const created = await createMember(env.PHOTOS, {
          email,
          password,
          fullName: "VAYAM Designers",
          phone: "",
          role: "admin",
        });
        if (created.ok) return signedIn(created.member, env.SESSION_SECRET, secure);
      } else {
        const repaired = {
          ...existing,
          role: "admin" as const,
          passwordHash: await hashPassword(password),
          lastSignInAt: Date.now(),
        };
        await putMember(env.PHOTOS, repaired);
        return signedIn(repaired, env.SESSION_SECRET, secure);
      }
    }

    const member = await authenticate(env.PHOTOS, email, password);
    // One message for both a missing account and a wrong password, so this
    // cannot be used to discover which addresses are registered.
    if (!member) return json({ error: "That email and password do not match" }, 401);

    const withRole = await ensureRole(env.PHOTOS, member, env.ADMIN_EMAIL);
    return signedIn(withRole, env.SESSION_SECRET, secure);
  }

  return json({ error: "Not found" }, 404);
}

async function signedIn(
  member: Awaited<ReturnType<typeof authenticate>> & object,
  secret: string,
  secure: boolean,
): Promise<Response> {
  const token = await createSessionToken(member.id, secret);
  return new Response(JSON.stringify(toPublicMember(member)), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "set-cookie": sessionCookieHeader(token, { secure }),
    },
  });
}

/**
 * Removes a member's face and everything derived from it.
 *
 * Clearing the embeddings alone is not enough: cached scan results were built
 * from them and would keep showing matches computed from a face the member has
 * asked us to forget.
 */
async function forgetFace(env: MediaEnv, member: MemberRecord): Promise<Response> {
  await putMember(env.PHOTOS, {
    ...member,
    references: [],
    referenceImageKey: null,
    onboarded: false,
  });

  const stale: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.PHOTOS.list({ prefix: `scan/${member.id}/`, cursor, limit: 1000 });
    for (const o of page.objects) stale.push(o.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  if (stale.length) await env.PHOTOS.delete(stale);

  return json({ ok: true, clearedScans: stale.length });
}

/* --------------------------------- members -------------------------------- */

/**
 * The client list for the operator console.
 *
 * Read from R2, where sign-up already writes. This used to go through the old
 * service's admin API, which is why the panel demanded a key that bypasses
 * every access rule just to show a list of names.
 *
 * Operators are left out: they are staff, not clients, and this list exists to
 * be exported and worked from.
 */
async function listMembers(env: MediaEnv): Promise<Response> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.PHOTOS.list({ prefix: "meta/member/", cursor, limit: 1000 });
    for (const o of page.objects) keys.push(o.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const records = await mapLimit(keys, READ_CONCURRENCY, (k) =>
    readJson<{
      id: string;
      email: string;
      fullName: string;
      phone: string;
      role: string;
      onboarded: boolean;
      references: number[][];
      createdAt: number;
      lastSignInAt: number | null;
    }>(env.PHOTOS, k),
  );

  const members = records
    .filter((m): m is NonNullable<typeof m> => m !== null && m.role !== "admin")
    .map((m) => ({
      id: m.id,
      fullName: m.fullName,
      phone: m.phone,
      email: m.email,
      joinedAt: m.createdAt ? new Date(m.createdAt).toISOString() : null,
      lastSignInAt: m.lastSignInAt ? new Date(m.lastSignInAt).toISOString() : null,
      // Never the embeddings themselves, only whether any exist.
      hasFaceProfile: (m.references?.length ?? 0) > 0,
      photosFound: 0,
    }))
    .sort((a, b) => (b.joinedAt ?? "").localeCompare(a.joinedAt ?? ""));

  // Match counts come from each member's cached scans, one read per scan.
  const scanKeys: string[] = [];
  let scanCursor: string | undefined;
  do {
    const page = await env.PHOTOS.list({ prefix: "scan/", cursor: scanCursor, limit: 1000 });
    for (const o of page.objects) scanKeys.push(o.key);
    scanCursor = page.truncated ? page.cursor : undefined;
  } while (scanCursor);

  const counts = new Map<string, number>();
  await mapLimit(scanKeys, READ_CONCURRENCY, async (k) => {
    const record = await readJson<ScanRecord>(env.PHOTOS, k);
    if (!record) return;
    counts.set(record.userId, (counts.get(record.userId) ?? 0) + record.hits.length);
  });
  for (const m of members) m.photosFound = counts.get(m.id) ?? 0;

  return json({ members });
}

/* ----------------------------- index status ------------------------------- */

export type CollectionStatus = {
  photos: number;
  /** Photos we have detection results for, whether or not a face was found. */
  processed: number;
  /** Photos that actually contain at least one face. */
  withFaces: number;
  /** Faces detected across the collection. */
  faces: number;
  /** Photos whose faces are confirmed live in the search index. */
  indexed: number;
  /** Photos with faces that are not in the index yet. */
  pending: number;
};

/**
 * The truth about a collection, read from the face records in R2.
 *
 * This exists because "the search found nothing" has several very different
 * causes and they need different answers: photos never detected, faces
 * detected but never indexed, the index still catching up, or the member
 * genuinely not being there. Guessing between them produced a "still indexing"
 * message that never went away.
 */
async function collectionStatus(env: MediaEnv, cid: string): Promise<CollectionStatus> {
  const photoKeys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.PHOTOS.list({ prefix: `meta/photo/${cid}/`, cursor, limit: 1000 });
    for (const o of page.objects) photoKeys.push(o.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const faceKeys: string[] = [];
  cursor = undefined;
  do {
    const page = await env.PHOTOS.list({ prefix: `meta/faces/${cid}/`, cursor, limit: 1000 });
    for (const o of page.objects) faceKeys.push(o.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const records = await mapLimit(faceKeys, READ_CONCURRENCY, (k) =>
    readJson<{ indexedAt: number | null; faces: unknown[] }>(env.PHOTOS, k),
  );

  let withFaces = 0;
  let faces = 0;
  let indexed = 0;
  for (const r of records) {
    if (!r) continue;
    const count = r.faces?.length ?? 0;
    if (count === 0) continue;
    withFaces++;
    faces += count;
    if (r.indexedAt) indexed++;
  }

  return {
    photos: photoKeys.length,
    processed: records.filter((r) => r !== null).length,
    withFaces,
    faces,
    indexed,
    pending: withFaces - indexed,
  };
}

/**
 * Rebuilds the search index for a collection from the descriptors in R2.
 *
 * This is what makes R2 the record and the index merely derived. Photos
 * uploaded while the index was unreachable, or before indexing existed at all,
 * are recoverable without re-uploading or re-detecting anything: the expensive
 * work was detection, and that was kept.
 */
async function reindexCollection(env: MediaEnv, cid: string): Promise<Response> {
  if (!env.FACE_INDEX) return json({ error: "The face index is unavailable" }, 503);

  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.PHOTOS.list({ prefix: `meta/faces/${cid}/`, cursor, limit: 1000 });
    for (const o of page.objects) keys.push(o.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  let photos = 0;
  let vectors = 0;

  // Sequential batches: this can touch a whole event, and hammering the index
  // in parallel buys nothing when the writes are applied asynchronously anyway.
  for (let i = 0; i < keys.length; i += 25) {
    const batch = keys.slice(i, i + 25);
    const records = await mapLimit(batch, 25, async (key) => ({
      photoId: key.slice(`meta/faces/${cid}/`.length),
      record: await readJson<{ faces: { descriptor: number[] }[] }>(env.PHOTOS, key),
      key,
    }));

    for (const { photoId, record, key } of records) {
      const descriptors = (record?.faces ?? [])
        .map((f) => f.descriptor)
        .filter((d) => Array.isArray(d) && d.length === DESCRIPTOR_DIM);
      if (descriptors.length === 0) continue;

      const result = await indexPhotoFaces(env.FACE_INDEX, {
        collectionId: cid,
        photoId,
        descriptors,
      });
      vectors += result.indexed;
      photos++;

      await writeJson(env.PHOTOS, key, { ...record, indexedAt: Date.now() });
    }
  }

  return json({ photos, vectors, note: "Indexing is applied asynchronously; allow a minute." });
}

/**
 * Proves the search works, using this collection's own faces.
 *
 * Takes a face that is already indexed, searches with it as if it were a
 * member's reference, and checks that its own photo comes back. If it does,
 * detection, indexing and searching are all sound and any "no match" is a real
 * answer about that person. If it does not, the fault is in the pipeline and
 * the member is being told something false.
 *
 * Without this, the two are indistinguishable from the outside, which is
 * exactly the position we were in.
 */
async function selfTest(env: MediaEnv, cid: string): Promise<Response> {
  if (!env.FACE_INDEX) return json({ error: "The face index is unavailable" }, 503);

  const page = await env.PHOTOS.list({ prefix: `meta/faces/${cid}/`, limit: 50 });
  let chosen: { photoId: string; descriptor: number[] } | null = null;
  let staleFaces = 0;

  for (const o of page.objects) {
    const record = await readJson<{ faces: { descriptor: number[] }[] }>(env.PHOTOS, o.key);
    const descriptor = record?.faces?.[0]?.descriptor;
    if (!Array.isArray(descriptor)) continue;
    if (descriptor.length !== DESCRIPTOR_DIM) {
      staleFaces++;
      continue;
    }
    chosen = { photoId: o.key.slice(`meta/faces/${cid}/`.length), descriptor };
    break;
  }

  // A face of the wrong width was written by the previous recogniser. It is not
  // corrupt and the photograph is fine; the numbers simply describe a different
  // space and will never match anything the current model produces. Say so,
  // rather than reporting an empty collection, because the fix is one button.
  if (!chosen) {
    return json({
      ok: false,
      reason: staleFaces
        ? `${staleFaces} photo(s) here were analysed by the previous recogniser. Open this event and press Re-analyse.`
        : "No indexed faces to test with",
      ...(staleFaces ? { staleFaces } : {}),
    });
  }

  const outcome = await searchCollection(env.FACE_INDEX, {
    collectionId: cid,
    references: [chosen.descriptor],
    threshold: MATCH_MAX_DISTANCE,
  });

  const foundItself = outcome.matches.some((m) => m.photoId === chosen!.photoId);

  // Finding itself is necessary but nowhere near sufficient. If every face in a
  // collection sits within the match threshold of every other, the search
  // "works" and is useless, because each member matches every photo. The
  // distance spread between distinct faces is what tells the two apart, so it
  // is measured here rather than inferred from match counts.
  const sample: number[][] = [];
  const page2 = await env.PHOTOS.list({ prefix: `meta/faces/${cid}/`, limit: 40 });
  for (const o of page2.objects) {
    const record = await readJson<{ faces: { descriptor: number[] }[] }>(env.PHOTOS, o.key);
    for (const f of record?.faces ?? []) {
      if (Array.isArray(f.descriptor) && f.descriptor.length === DESCRIPTOR_DIM) sample.push(f.descriptor);
    }
    if (sample.length >= 40) break;
  }

  // Cosine distance, the same units as MATCH_MAX_DISTANCE and the same thing
  // the index reports. This used to be a Euclidean sum over the first 128
  // components, which was right for the old descriptor and, after the change,
  // was measuring a fraction of a vector in the wrong metric: it read 0.68
  // where the real figure was 0.91, and made a healthy collection look as
  // though every face in it sat on top of every other.
  const distances: number[] = [];
  for (let i = 0; i < sample.length; i++) {
    for (let j = i + 1; j < sample.length; j++) {
      distances.push(cosineDistance(sample[i]!, sample[j]!));
    }
  }
  distances.sort((a, b) => a - b);

  const at = (q: number) => distances[Math.floor(distances.length * q)] ?? 0;
  const spread =
    distances.length === 0
      ? null
      : {
          pairs: distances.length,
          min: +at(0).toFixed(3),
          p25: +at(0.25).toFixed(3),
          median: +at(0.5).toFixed(3),
          p75: +at(0.75).toFixed(3),
          max: +distances[distances.length - 1]!.toFixed(3),
          /** Share of face pairs the threshold would call the same person. */
          withinThreshold: +(
            distances.filter((d) => d <= MATCH_MAX_DISTANCE).length / distances.length
          ).toFixed(3),
        };

  // In a normal collection most pairs are different people and sit far apart,
  // so only a small share fall inside the threshold. A high share means the
  // embeddings are not discriminating and no threshold will save the search.
  const healthy = spread === null || spread.withinThreshold < 0.25;

  return json({
    ok: foundItself && healthy,
    testedPhoto: chosen.photoId,
    foundItself,
    totalMatches: outcome.matches.length,
    seedFaces: outcome.stats.seedFaces,
    linkedFaces: outcome.stats.linkedFaces,
    spread,
    verdict: !foundItself
      ? "Search is NOT working: a face taken straight from the index cannot find itself."
      : healthy
        ? "Search is working. Faces find themselves and distinct faces stay apart."
        : "Faces are not distinguishable from each other: too many pairs fall inside the match threshold, so everyone will match everything.",
  });
}

/* ------------------------------ face profile ------------------------------ */

/**
 * Stores a member's reference faces on their own record.
 *
 * Embeddings arrive from the browser, where detection runs, so the photograph
 * itself never leaves the member's machine.
 */
async function saveFaceProfile(
  request: Request,
  env: MediaEnv,
  userId: string,
): Promise<Response> {
  let body: { references?: number[][]; imageKey?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "Malformed body" }, 400);
  }

  const references = Array.isArray(body.references) ? body.references.slice(0, 8) : [];
  if (references.length === 0) return json({ error: "No reference face supplied" }, 400);
  for (const r of references) {
    if (
      !Array.isArray(r) ||
      r.length !== DESCRIPTOR_DIM ||
      r.some((n) => typeof n !== "number" || !Number.isFinite(n))
    ) {
      return json({ error: `Each reference must be ${DESCRIPTOR_DIM} numbers` }, 400);
    }
  }

  const member = await getMemberById(env.PHOTOS, userId);
  if (!member) return json({ error: "No such member" }, 401);

  await putMember(env.PHOTOS, {
    ...member,
    references,
    referenceImageKey: body.imageKey ?? member.referenceImageKey,
    onboarded: true,
  });
  return json({ ok: true, references: references.length });
}

/* -------------------------------------------------------------------------- */
/*                              Waiting for photos                            */
/* -------------------------------------------------------------------------- */

/**
 * Someone who searched and found nothing.
 *
 * At a live event this is almost never "you are not in the photographs". It is
 * "the photographer has not reached you yet", and that is something the team
 * can act on within minutes if they know about it. So every empty search is
 * recorded against the member, with how many times they have tried, and the
 * console shows the list newest first.
 *
 * The record is deleted the moment a search of theirs succeeds, so the list is
 * the people still waiting rather than a log of everyone who ever waited.
 */
export type WaitingRecord = {
  userId: string;
  fullName: string;
  email: string;
  phone: string;
  collectionId: string;
  collectionName: string;
  /** When they first came up empty in this event. */
  firstAskedAt: number;
  /** When they last tried. */
  lastAskedAt: number;
  attempts: number;
  /** Whether they have a reference face at all, which changes what to do. */
  hasReference: boolean;
};

const waitingKey = (userId: string, cid: string) => `waiting/${cid}/${userId}`;

/** Records an empty search, or updates the one already there. */
async function noteWaiting(
  env: MediaEnv,
  member: MemberRecord,
  cid: string,
  collectionName: string,
  hasReference: boolean,
): Promise<void> {
  const key = waitingKey(member.id, cid);
  const existing = await readJson<WaitingRecord>(env.PHOTOS, key);
  const now = Date.now();
  await writeJson(env.PHOTOS, key, {
    userId: member.id,
    fullName: member.fullName,
    email: member.email,
    phone: member.phone,
    collectionId: cid,
    collectionName,
    firstAskedAt: existing?.firstAskedAt ?? now,
    lastAskedAt: now,
    attempts: (existing?.attempts ?? 0) + 1,
    hasReference,
  } satisfies WaitingRecord);
}

/** Clears the record once this person has been found. */
async function clearWaiting(env: MediaEnv, userId: string, cid: string): Promise<void> {
  await env.PHOTOS.delete(waitingKey(userId, cid)).catch(() => undefined);
}

/**
 * Everyone still waiting, newest first.
 *
 * Deliberately not paginated. If this list is long enough to need paging, the
 * event has a problem no interface is going to solve.
 */
async function listWaiting(env: MediaEnv): Promise<Response> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.PHOTOS.list({ prefix: "waiting/", cursor, limit: 1000 });
    for (const o of page.objects) keys.push(o.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const rows = await mapLimit(keys, READ_CONCURRENCY, (k) =>
    readJson<WaitingRecord>(env.PHOTOS, k),
  );
  const waiting = rows
    .filter((r): r is WaitingRecord => r !== null)
    .sort((a, b) => b.lastAskedAt - a.lastAskedAt);

  return json({ waiting });
}

/* ---------------------------------- scan ---------------------------------- */

/**
 * Finds a member in a collection.
 *
 * Runs on the Worker rather than the browser because a forty thousand photo
 * collection holds around a hundred thousand faces, and shipping those to the
 * browser is fifty megabytes before any searching starts. Here it is a handful
 * of index lookups whose cost does not grow with the collection.
 *
 * Results come back in two tiers. Confident matches are what the member came
 * for. Possible matches sit past the threshold, in the range where a person
 * would want to glance rather than be told no, and are offered separately with
 * their confidence rather than silently discarded.
 */
async function runScan(request: Request, env: MediaEnv, userId: string): Promise<Response> {
  let body: { collectionId?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "Malformed body" }, 400);
  }
  const cid = body.collectionId ?? "";
  if (!isSafeId(cid)) return json({ error: "Unknown collection" }, 400);

  const member = await getMemberById(env.PHOTOS, userId);
  if (!member) return json({ error: "No such member" }, 401);

  // A reference of the wrong width is a profile from the old face-api model,
  // which described faces in 128 numbers rather than 512 and in a space these
  // vectors have nothing to do with. Comparing across the two would not throw,
  // it would just never match anything, and the member would be told they are
  // not in the photographs. Treat it as no face at all, so they are asked for
  // a new photo instead.
  const usable = member.references.filter((r) => r.length === DESCRIPTOR_DIM);
  if (usable.length === 0) {
    // They asked, which is the fact the team needs, whether or not they got as
    // far as giving us a face.
    const named = await readJson<CollectionRecord>(env.PHOTOS, collectionKey(cid));
    await noteWaiting(env, member, cid, named?.name ?? cid, false).catch(() => undefined);
    return json({
      error: member.references.length
        ? "Your reference photo was taken with the old recogniser. Please add it again."
        : "Add a reference photo of yourself first",
      code: "no-face",
    }, 400);
  }
  if (!env.FACE_INDEX) {
    return json({ error: "The face index is unavailable", code: "no-index" }, 503);
  }

  // The seed threshold stays tight. Widening it to reach turned-away shots
  // would let strangers into the first round, and the expansion then walks
  // outward from a wrong face. Angles are recovered by the walk, not by
  // loosening the number.
  // Timing is recorded rather than guessed at. The target is six seconds end to
  // end, and when a scan misses it the answer is entirely different depending on
  // whether the index lookups were slow or the photo records behind them were,
  // so the two are measured apart.
  const tSearch = Date.now();
  const outcome = await searchCollection(env.FACE_INDEX, {
    collectionId: cid,
    references: usable,
    threshold: MATCH_MAX_DISTANCE,
  });
  const searchMs = Date.now() - tSearch;
  const tRead = Date.now();

  const decorated = await mapLimit(outcome.matches, READ_CONCURRENCY, async (m) => {
    const meta = await readJson<PhotoMeta>(env.PHOTOS, photoMetaKey(cid, m.photoId));
    if (!meta) return null;
    return {
      photoId: m.photoId,
      hops: m.hops,
      confidence: confidenceFor(m.distance, m.hops),
      fileName: meta.fileName,
      width: meta.width,
      height: meta.height,
      thumbUrl: mediaUrl(cid, m.photoId, "t"),
      fullUrl: mediaUrl(cid, m.photoId),
    };
  });

  const all = decorated.filter((h): h is NonNullable<typeof h> => h !== null);

  // A match whose photo record is missing cannot be rendered, so it is dropped.
  // Counting them makes that visible: a scan that matches faces and shows
  // nothing is otherwise indistinguishable from a scan that matched nothing,
  // and the two need completely different fixes.
  const orphaned = outcome.matches.length - all.length;
  if (orphaned > 0) {
    console.warn(
      `[scan] ${orphaned} match(es) in ${cid} had no photo record and were dropped`,
    );
  }
  // A member is shown matches and nothing else.
  //
  // There used to be a second tier of near-misses behind a "show possible
  // matches" control, on the reasoning that a person would rather glance than
  // be told no. On these photographs that tier was where the strangers were,
  // and being shown a stranger reads as the system being broken rather than as
  // an invitation to judge. Anything that does not clear the threshold is now
  // simply not a match.
  const hits: ScanHit[] = all.filter((h) => h.confidence >= CONFIDENT_THRESHOLD);
  const possible: ScanHit[] = [];
  hits.sort((a, b) => b.confidence - a.confidence);

  const belowBar = all.length - hits.length;
  if (belowBar > 0) {
    console.log(`[scan] ${belowBar} match(es) in ${cid} fell below the confidence bar and were not shown`);
  }

  // "The search found nothing" has several causes and they need different
  // answers. Guessing from photo count alone produced a "still indexing"
  // message that never cleared, because a collection whose faces were never
  // indexed looks identical to one the index has not caught up with.
  //
  // The face records in R2 tell them apart: how many photos were detected, how
  // many hold a face, and how many of those reached the index.
  const readMs = Date.now() - tRead;
  const foundNothing = outcome.stats.seedFaces === 0;

  // collectionStatus lists and reads every face record in the collection, which
  // measured between 0.9 and 1.4 seconds, about a third of a scan. It exists to
  // explain an empty result, so a scan that found somebody does not need it and
  // no longer waits for it. That is the difference between a scan at four
  // seconds and one at two and a half, against a six second budget.
  const tStatus = Date.now();
  const status = foundNothing ? await collectionStatus(env, cid) : null;
  const statusMs = Date.now() - tStatus;

  const state: ScanRecord["state"] =
    !status ? "ok"
    : status.photos === 0 ? "empty"
    : status.processed === 0 ? "not-processed"
    : status.withFaces === 0 ? "no-faces"
    : status.pending > 0 ? "indexing"
    : "no-match";

  const record: ScanRecord = {
    userId,
    collectionId: cid,
    hits,
    possible,
    scannedAt: Date.now(),
    matcher: MATCHER_VERSION,
    facesSearched: outcome.stats.seedFaces + outcome.stats.linkedFaces,
    state,
    ...(status ? { index: status } : {}),
    timing: { searchMs, readMs, statusMs, totalMs: searchMs + readMs + statusMs },
    ...(orphaned > 0 ? { orphaned } : {}),
  };
  await writeJson(env.PHOTOS, scanKey(userId, cid), record);

  // The team needs to know who is still waiting while the event is running, not
  // afterwards. Written on the way out of the scan so the console is current
  // within a second of someone pressing Find me.
  if (hits.length === 0) {
    const named = await readJson<CollectionRecord>(env.PHOTOS, collectionKey(cid));
    await noteWaiting(env, member, cid, named?.name ?? cid, true).catch(() => undefined);
  } else {
    await clearWaiting(env, userId, cid);
  }

  return json(record);
}
