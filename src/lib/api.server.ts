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
import { searchCollection } from "./face-index.server.ts";
import { MATCH_MAX_DISTANCE } from "./face.ts";
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
  /**
   * Matches whose photo record was missing, so they could not be shown.
   * Surfaced rather than swallowed: a scan that matches faces and displays
   * nothing needs a different fix from one that matched nothing.
   */
  orphaned?: number;
  /**
   * True when the collection holds photos that the search index has not caught
   * up with. Vectorize applies writes asynchronously, so a scan run moments
   * after an upload genuinely cannot see those faces yet.
   */
  indexLagging?: boolean;
};

const collectionKey = (cid: string) => `meta/collection/${cid}`;
const scanKey = (userId: string, cid: string) => `scan/${userId}/${cid}`;

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
 * Turns a distance into a confidence a person can act on.
 *
 * The old figure was `1 - distance / 1.1`, which put a solid match at 58
 * percent and read to a member like a coin flip. It carried no meaning; it was
 * just the distance rescaled.
 *
 * This maps the range that actually matters onto the range people expect. At or
 * below CERTAIN the same person is not in doubt, so it reads high. At the match
 * threshold it reads around 80, which is what "we are confident" should look
 * like. Past the threshold it falls away through the region where a match is
 * possible but wants a human glance, and reaches zero where a stranger sits.
 */
export const CERTAIN_DISTANCE = 0.30;
const STRANGER_DISTANCE = 0.95;

/** Below this, a result is offered as "possible" rather than asserted. */
export const CONFIDENT_THRESHOLD = 0.75;

/**
 * Hops are evidence too, and weaker evidence than a direct match.
 *
 * A face matched straight off the member's own reference is more certain than
 * one reached by chaining through three intermediate photos, even when both
 * measure the same distance to whatever linked them. Each hop takes a little
 * off, which is what separates the confident tier from the possible one for
 * turned-away shots.
 */
const HOP_PENALTY = 0.06;

export function confidenceFor(distance: number, hops = 0): number {
  let base: number;
  if (distance <= CERTAIN_DISTANCE) {
    // 0.98 down to 0.90 across the region where there is no real doubt.
    base = 0.98 - (distance / CERTAIN_DISTANCE) * 0.08;
  } else if (distance <= MATCH_MAX_DISTANCE) {
    const t = (distance - CERTAIN_DISTANCE) / (MATCH_MAX_DISTANCE - CERTAIN_DISTANCE);
    base = 0.9 - t * 0.1; // 0.90 -> 0.80
  } else if (distance <= STRANGER_DISTANCE) {
    const t = (distance - MATCH_MAX_DISTANCE) / (STRANGER_DISTANCE - MATCH_MAX_DISTANCE);
    base = Math.max(0, 0.8 - t * 0.8); // 0.80 -> 0
  } else {
    base = 0;
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
    return json({ error: "Not found" }, 404);
  }

  if (head === "members" && request.method === "GET") {
    if (!isAdmin) return json({ error: "Admins only" }, 403);
    return listMembers(env);
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
      return json(cached ?? { hits: [], possible: [], scannedAt: 0, facesSearched: 0 });
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
    async (c) => ({
      ...c,
      photoCount: await countPhotos(env.PHOTOS, c.id),
      coverUrl: c.coverPhotoId ? mediaUrl(c.id, c.coverPhotoId, "t") : null,
    }),
  );

  collections.sort((a, b) => b.createdAt - a.createdAt);
  return json({ collections });
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
    if (!Array.isArray(r) || r.length !== 128 || r.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
      return json({ error: "Each reference must be 128 numbers" }, 400);
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
  if (member.references.length === 0) {
    return json({ error: "Add a reference photo of yourself first", code: "no-face" }, 400);
  }
  if (!env.FACE_INDEX) {
    return json({ error: "The face index is unavailable", code: "no-index" }, 503);
  }

  // The seed threshold stays tight. Widening it to reach turned-away shots
  // would let strangers into the first round, and the expansion then walks
  // outward from a wrong face. Angles are recovered by the walk, not by
  // loosening the number.
  const outcome = await searchCollection(env.FACE_INDEX, {
    collectionId: cid,
    references: member.references,
    threshold: MATCH_MAX_DISTANCE,
  });

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
  const hits: ScanHit[] = [];
  const possible: ScanHit[] = [];
  for (const hit of all) {
    // Everything here is a real match. The split is about how sure we are, so
    // a member can see the marginal ones rather than have them silently
    // dropped, which is what was asked for.
    (hit.confidence >= CONFIDENT_THRESHOLD ? hits : possible).push(hit);
  }
  hits.sort((a, b) => b.confidence - a.confidence);
  possible.sort((a, b) => b.confidence - a.confidence);

  // Vectorize applies writes asynchronously, so a collection can hold photos
  // whose faces are not searchable yet. Saying "no matches" then is wrong and
  // sends people away; saying "still indexing" tells them to try again.
  const photoCount = await countPhotos(env.PHOTOS, cid);
  const indexLagging = photoCount > 0 && outcome.stats.seedFaces === 0;

  const record: ScanRecord = {
    userId,
    collectionId: cid,
    hits,
    possible,
    scannedAt: Date.now(),
    facesSearched: outcome.stats.seedFaces + outcome.stats.linkedFaces,
    ...(orphaned > 0 ? { orphaned } : {}),
    ...(indexLagging ? { indexLagging: true } : {}),
  };
  await writeJson(env.PHOTOS, scanKey(userId, cid), record);
  return json(record);
}
