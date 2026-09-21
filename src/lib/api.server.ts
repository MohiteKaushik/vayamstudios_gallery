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
  facePhotoKey,
  mediaUrl,
  DESCRIPTOR_DIM,
  type MediaEnv,
  type PhotoMeta,
  BinError,
  binPhotos,
  deleteForever,
  isBinId,
  listBin,
  purgeExpired,
  readBinGroup,
  restoreFromBin,
  trashEvent,
} from "./media.server.ts";
import {
  getMemberById,
  getMemberByEmail,
  putMember,
  toPublicMember,
  createMember,
  createGoogleMember,
  authenticate,
  ensureRole,
  getMemberByGoogleSub,
  linkGoogleMember,
  type MemberRecord,
} from "./auth/members.server.ts";
import {
  createSessionToken,
  sessionCookieHeader,
  clearSessionCookieHeader,
  isSecureRequest,
  readCookie,
} from "./auth/session.ts";
import { hashPassword } from "./auth/password.ts";
import { normalisePhone, validateEmail, validatePassword, validatePhone, validateSignUp } from "./members.ts";
import { searchCollection, indexPhotoFaces } from "./face-index.server.ts";
import { MATCH_MAX_DISTANCE } from "./face.ts";
import { cosineDistance } from "./insightface.ts";
import { isFingerprint } from "./duplicates.ts";
import { events as pastEvents, eventTitle, shownTitle, LEGACY_RECENT_EVENT_ID, type ShowcaseEvent } from "./vayam.ts";
import type { R2Bucket } from "./storage.server.ts";

export const API_PREFIX = "/api";

export type CollectionRecord = {
  id: string;
  name: string;
  description: string | null;
  coverPhotoId: string | null;
  createdBy: string;
  createdAt: number;
  showcaseEventId?: string;
  recent?: boolean;
  /** Keeps an event alive without exposing its empty starter album. */
  containerOnly?: boolean;
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

  // Shared galleries expose only explicitly shared event previews.
  if (head === "auth") return handleAuth(request, env, rest);
  if (head === "share") return publicEventShare(request, env, url, rest);

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
    if (rest.length === 0 && request.method === "GET") return listCollections(env, url.searchParams.get("recent") === "1", url.searchParams.get("event"), isAdmin);
    if (rest.length === 0 && request.method === "POST") {
      if (!isAdmin) return json({ error: "Admins only" }, 403);
      return createCollection(request, env, userId);
    }
    const cid = rest[0] ?? "";
    if (!isSafeId(cid)) return json({ error: "Unknown collection" }, 400);
    if (!isAdmin && await collectionHidden(env, cid)) return json({ error: "This event is not available" }, 404);
    if (rest.length === 1 && request.method === "PATCH") {
      if (!isAdmin) return json({ error: "Admins only" }, 403);
      return renameCollection(request, env, cid);
    }
    if (rest[1] === "fingerprints" && request.method === "POST") {
      if (!isAdmin) return json({ error: "Admins only" }, 403);
      return saveFingerprints(request, env, cid);
    }
    if (rest[1] === "photos" && request.method === "GET") {
      // An event in the recycle bin has no record, and nobody should be able to
      // page through its photographs by id while it is there.
      if (!(await env.PHOTOS.head(collectionKey(cid)))) {
        return json({ error: "This event is not available" }, 404);
      }
      const filename = url.searchParams.get("filename")?.trim() ?? "";
      if (filename && !isAdmin) return json({ error: "Admins only" }, 403);
      if (filename.length > 200) return json({ error: "Use a shorter filename" }, 400);
      return listPhotos(env, cid, url.searchParams.get("cursor"), url.searchParams.get("limit"), filename);
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

  if (head === "site" && rest[0] === "events") {
    if (rest[1] === "share") {
      if (!isAdmin) return json({ error: "Admins only" }, 403);
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      let body: { id?: string } | null;
      try { body = await request.json() as typeof body; } catch { return json({ error: "Malformed body" }, 400); }
      if (!body || typeof body.id !== "string") return json({ error: "Choose an event to share" }, 400);
      const event = (await readShowcase(env)).find((e) => e.id === body?.id);
      if (!event || event.hidden) return json({ error: "Unhide the event before sharing it" }, 404);
      const key = `site/event-share/${event.id}`;
      const previous = await readJson<{ token: string }>(env.PHOTOS, key);
      const token = previous?.token ?? crypto.randomUUID();
      await writeJson(env.PHOTOS, `site/share-links/${token}`, { eventId: event.id });
      await writeJson(env.PHOTOS, key, { token });
      return json({ path: `/share/${token}` });
    }
    if (request.method === "GET") return json({ events: (await readShowcase(env)).filter((event) => isAdmin || !event.hidden) });
    if (!isAdmin) return json({ error: "Admins only" }, 403);
    if (request.method === "PATCH") return setRecentEvent(request, env, userId);
    if (request.method === "PUT") return setEventHidden(request, env);
    if (request.method === "DELETE") return deleteShowcaseEvent(request, env, userId);
    return json({ error: "Method not allowed" }, 405);
  }

  if (head === "site" && rest[0] === "past-events") {
    if (request.method === "GET") return json({ renames: await readRenames(env) });
    if (!isAdmin) return json({ error: "Admins only" }, 403);
    if (request.method === "PUT") return renamePastEvent(request, env);
    return json({ error: "Method not allowed" }, 405);
  }

  if (head === "site" && rest[0] === "cover") {
    if (request.method === "GET") return json(await readHomeCover(env, isAdmin));
    if (!isAdmin) return json({ error: "Admins only" }, 403);
    if (request.method === "PUT") return setHomeCover(request, env);
    if (request.method === "DELETE") {
      await env.PHOTOS.delete(HOME_COVER_KEY);
      return json({ coverUrl: null, collectionId: null, photoId: null });
    }
    return json({ error: "Method not allowed" }, 405);
  }

  if (head === "members" && request.method === "GET") {
    if (!isAdmin) return json({ error: "Admins only" }, 403);
    return listMembers(env);
  }

  if (head === "waiting" && request.method === "GET") {
    if (!isAdmin) return json({ error: "Admins only" }, 403);
    return listWaiting(env);
  }

  if (head === "admin" && rest[0] === "photo-search" && request.method === "POST") {
    if (!isAdmin) return json({ error: "Admins only" }, 403);
    return adminPhotoSearch(request, env);
  }

  if (head === "bin") {
    if (!isAdmin) return json({ error: "Admins only" }, 403);
    return handleBin(request, env, rest);
  }

  if (head === "face-profile") {
    if (request.method === "POST") return saveFaceProfile(request, env, userId);
    if (request.method === "DELETE") return forgetFace(env, member);
  }

  if (head === "scan") {
    if (request.method === "POST") return runScan(request, env, userId);
    const cid = rest[0] ?? "";
    if (request.method === "GET" && isSafeId(cid)) {
      if (!isAdmin && await collectionHidden(env, cid)) return json({ error: "This event is not available" }, 404);
      const cached = await readJson<ScanRecord>(env.PHOTOS, scanKey(userId, cid));
      const current = cached?.matcher === MATCHER_VERSION ? cached : null;
      const empty = { hits: [], possible: [], scannedAt: 0, facesSearched: 0 };
      if (!current || !(await env.PHOTOS.head(collectionKey(cid)))) return json(empty);

      // A saved result can name photos an operator has since moved to the
      // recycle bin. Their images still exist until the bin is emptied, so they
      // would still show, which is exactly what deleting them was meant to stop.
      const live = await mapLimit(current.hits, READ_CONCURRENCY, async (hit) =>
        (await env.PHOTOS.head(photoMetaKey(cid, hit.photoId))) ? hit : null,
      );
      return json({ ...current, hits: live.filter((h): h is ScanHit => h !== null) });
    }
  }

  return json({ error: "Not found" }, 404);
}

/* ------------------------------- collections ------------------------------ */

async function collectionRecords(env: MediaEnv): Promise<CollectionRecord[]> {
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
  return records.filter((r): r is CollectionRecord => r !== null);
}

async function listCollections(env: MediaEnv, recentOnly = false, eventId: string | null = null, isAdmin = false): Promise<Response> {
  let records = await collectionRecords(env);
  const events = (await readShowcase(env, records)).filter((event) => isAdmin || !event.hidden);
  records = records.filter((record) => !record.containerOnly);
  if (!isAdmin) {
    const visibleIds = new Set(events.flatMap((event) => event.collectionIds));
    records = records.filter((record) => visibleIds.has(record.id));
  }
  let selectedEvent: ShowcaseEvent | undefined;
  if (eventId !== null) {
    selectedEvent = events.find((event) => event.id === eventId);
    if (!selectedEvent) return json({ error: "This event is no longer available" }, 404);
    const ids = new Set(selectedEvent.collectionIds);
    records = records.filter((record) => ids.has(record.id));
  } else if (recentOnly) {
    const ids = new Set(events.filter((event) => event.recent && !event.hidden).flatMap((event) => event.collectionIds));
    records = records.filter((record) => ids.has(record.id));
  }

  // Photo counts come from counting keys, which needs no record reads.
  const collections = await mapLimit(
    records,
    10,
    async (c) => {
      const cover = c.coverPhotoId ?? (await firstPhotoId(env.PHOTOS, c.id));
      return {
        ...c,
        showcaseEventId: c.showcaseEventId ?? LEGACY_RECENT_EVENT_ID,
        coverPhotoId: cover,
        photoCount: await countPhotos(env.PHOTOS, c.id),
        coverUrl: cover ? mediaUrl(c.id, cover, "t") : null,
      };
    },
  );

  collections.sort((a, b) => b.createdAt - a.createdAt);
  return json({ collections, ...(selectedEvent ? { event: selectedEvent } : {}) });
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

const PAST_EVENTS_KEY = "site/past-events.json";

async function readShowcase(env: MediaEnv, records?: CollectionRecord[]): Promise<ShowcaseEvent[]> {
  const collections = records ?? await collectionRecords(env);
  const renames = await readRenames(env);
  const custom = collections.filter((c) => c.showcaseEventId === c.id).sort((a, b) => b.createdAt - a.createdAt);
  const events = [
    ...custom.map((c) => ({ id: c.id, name: c.name, recent: c.recent !== false })),
    ...[...pastEvents].reverse().map((e) => {
      const { year: _year, ...details } = e;
      return { ...details, name: shownTitle(e, renames), recent: e.id === LEGACY_RECENT_EVENT_ID };
    }),
  ];
  const resolved = await mapLimit(events, READ_CONCURRENCY, async (event) => {
    const setting = await readJson<{ recent?: boolean; deleted?: boolean; hidden?: boolean; eventName?: string }>(
      env.PHOTOS,
      `site/recent-events/${event.id}`,
    );
    return {
      ...event,
      name: setting?.eventName ?? event.name,
      deleted: setting?.deleted === true,
      hidden: setting?.hidden === true,
      recent: typeof setting?.recent === "boolean" ? setting.recent : event.recent,
      // Existing day albums belonged to TTPOC before event associations existed.
      collectionIds: collections
        .filter((c) => !c.containerOnly && (c.showcaseEventId ?? LEGACY_RECENT_EVENT_ID) === event.id)
        .map((c) => c.id),
    };
  });
  return resolved.filter((event) => !event.deleted).map(({ deleted: _deleted, ...event }) => event);
}

async function publicEventShare(request: Request, env: MediaEnv, url: URL, parts: string[]): Promise<Response> {
  const [token, action, cid, pid] = parts;
  const missing = () => json({ error: "This shared event is not available" }, 404);
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "Method not allowed" }, 405);
  if (!token || !isSafeId(token)) return missing();
  const link = await readJson<{ eventId: string }>(env.PHOTOS, `site/share-links/${token}`);
  if (!link) return missing();
  const setting = await readJson<{ hidden?: boolean; deleted?: boolean }>(env.PHOTOS, `site/recent-events/${link.eventId}`);
  if (setting?.hidden || setting?.deleted) return missing();
  if (!action && parts.length === 1) {
    const records = await collectionRecords(env);
    const event = (await readShowcase(env, records)).find((e) => e.id === link.eventId && !e.hidden);
    if (!event) return missing();
    return json({ event: { id: event.id, name: event.name }, albums: records
      .filter((c) => event.collectionIds.includes(c.id))
      .map((c) => ({ id: c.id, name: c.name })) });
  }
  if (!cid || !isSafeId(cid)) return missing();
  const album = await readJson<CollectionRecord>(env.PHOTOS, collectionKey(cid));
  if (!album || album.containerOnly || (album.showcaseEventId ?? LEGACY_RECENT_EVENT_ID) !== link.eventId) return missing();
  if (action === "photos" && parts.length === 3) {
    const page = await env.PHOTOS.list({ prefix: `meta/photo/${cid}/`, limit: 40,
      ...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}) });
    const records = await mapLimit(page.objects, READ_CONCURRENCY, (o) => readJson<PhotoMeta>(env.PHOTOS, o.key));
    return json({ photos: records.filter((p): p is PhotoMeta => !!p && isSafeId(p.id)).map((p) => {
      const preview = `/api/share/${token}/preview/${cid}/${p.id}`;
      return { id: p.id, fileName: p.fileName, width: p.width, height: p.height, thumbUrl: preview, fullUrl: preview };
    }), ...(page.truncated && page.cursor ? { cursor: page.cursor } : {}) });
  }
  if (action !== "preview" || parts.length !== 4 || !pid || !isSafeId(pid)) return missing();
  if (!(await env.PHOTOS.head(photoMetaKey(cid, pid)))) return missing();
  // Never fall back to an original, even when an old upload has no thumbnail.
  const object = await env.PHOTOS.get(`thumb/${cid}/${pid}`);
  if (!object) return missing();
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

async function collectionHidden(env: MediaEnv, cid: string): Promise<boolean> {
  const record = await readJson<CollectionRecord>(env.PHOTOS, collectionKey(cid));
  if (!record) return false;
  const setting = await readJson<{ hidden?: boolean; deleted?: boolean }>(env.PHOTOS,
    `site/recent-events/${record.showcaseEventId ?? LEGACY_RECENT_EVENT_ID}`);
  return setting?.hidden === true || setting?.deleted === true;
}

async function setEventHidden(request: Request, env: MediaEnv): Promise<Response> {
  let body: { id?: unknown; hidden?: unknown } | null;
  try { body = await request.json() as typeof body; } catch { return json({ error: "Malformed body" }, 400); }
  if (!body || typeof body.id !== "string" || typeof body.hidden !== "boolean") return json({ error: "An event and visibility setting are required" }, 400);
  if (!(await readShowcase(env)).some((event) => event.id === body.id)) return json({ error: "No such event" }, 404);
  const key = `site/recent-events/${body.id}`;
  const setting = await readJson<Record<string, unknown>>(env.PHOTOS, key);
  await writeJson(env.PHOTOS, key, { ...setting, hidden: body.hidden });
  return json({ events: await readShowcase(env) });
}

async function deleteShowcaseEvent(request: Request, env: MediaEnv, userId: string): Promise<Response> {
  let body: { id?: unknown; confirmed?: unknown } | null;
  try { body = await request.json() as typeof body; } catch { return json({ error: "Malformed body" }, 400); }
  if (!body || typeof body.id !== "string" || body.confirmed !== true) return json({ error: "Confirm the event deletion first" }, 400);
  const event = (await readShowcase(env)).find((e) => e.id === body.id);
  if (!event) return json({ error: "No such event" }, 404);
  // Include an internal custom-event container as well as its visible albums.
  // The container is hidden from galleries but must move with the whole event.
  const ids = (await collectionRecords(env))
    .filter((record) => (record.showcaseEventId ?? LEGACY_RECENT_EVENT_ID) === event.id)
    .map((record) => record.id);
  // Even a historical event without photos needs an archive record for recovery.
  if (!ids.length) {
    const id = crypto.randomUUID();
    const record: CollectionRecord = { id, name: event.name, description: null, coverPhotoId: null,
      createdBy: userId, createdAt: Date.now(), showcaseEventId: event.id };
    await writeJson(env.PHOTOS, collectionKey(id), record);
    ids.push(id);
  }
  const groups: string[] = [];
  try {
    for (const collectionId of ids) {
      const result = await trashEvent(env, { collectionId, userId, showcaseEventId: event.id });
      groups.push(result.groupId);
    }
    const key = `site/recent-events/${event.id}`;
    const previous = await readJson<Record<string, unknown>>(env.PHOTOS, key);
    await writeJson(env.PHOTOS, key, { ...previous, recent: event.recent, deleted: true });
  } catch {
    // Restore completed albums if a later move fails. Any failed recovery remains in the bin.
    await Promise.allSettled(groups.map((id) => restoreFromBin(env, id)));
    return json({ error: "Could not finish deleting the event. Refresh the list and check the recycle bin before retrying." }, 500);
  }
  return json({ groupIds: groups });
}

async function setRecentEvent(request: Request, env: MediaEnv, userId: string): Promise<Response> {
  let body: { id?: unknown; recent?: unknown } | null;
  try { body = await request.json() as typeof body; } catch { return json({ error: "Malformed body" }, 400); }
  if (!body || typeof body.id !== "string" || typeof body.recent !== "boolean") return json({ error: "An event and a boolean recent setting are required" }, 400);
  const event = (await readShowcase(env)).find((e) => e.id === body.id);
  if (!event) return json({ error: "No such event" }, 404);
  if (body.recent && !event.collectionIds.length) {
    const cid = crypto.randomUUID();
    const record: CollectionRecord = { id: cid, name: event.name, description: null, coverPhotoId: null,
      createdBy: userId, createdAt: Date.now(), showcaseEventId: event.id };
    await writeJson(env.PHOTOS, collectionKey(cid), record);
    const setting = await readJson<Record<string, unknown>>(env.PHOTOS, `site/recent-events/${event.id}`);
    await writeJson(env.PHOTOS, `site/recent-events/${event.id}`, { ...setting, recent: true });
  } else {
    const previous = await readJson<Record<string, unknown>>(env.PHOTOS, `site/recent-events/${event.id}`);
    await writeJson(env.PHOTOS, `site/recent-events/${event.id}`, { ...previous, recent: body.recent });
  }
  return json({ events: await readShowcase(env) });
}

async function readRenames(env: MediaEnv): Promise<Record<string, string>> {
  const stored = await readJson<{ renames?: Record<string, string> }>(env.PHOTOS, PAST_EVENTS_KEY);
  const known = new Set(pastEvents.map((e) => e.id));
  // Only ids still in the list count, so a removed event leaves nothing behind.
  return Object.fromEntries(
    Object.entries(stored?.renames ?? {}).filter(([id, title]) => known.has(id) && typeof title === "string"),
  );
}

/**
 * Renames one of the studio's past events. Saving the original title again
 * removes the rename rather than storing a copy of it.
 */
async function renamePastEvent(request: Request, env: MediaEnv): Promise<Response> {
  let body: { id?: unknown; title?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "Malformed body" }, 400);
  }
  if (!body || typeof body.id !== "string") return json({ error: "No such event" }, 404);
  const event = (await readShowcase(env)).find((e) => e.id === body.id);
  if (!event) return json({ error: "No such event" }, 404);
  const title = typeof body.title === "string" ? body.title.replace(/\s+/g, " ").trim() : "";
  if (title.length < 2 || title.length > 120) {
    return json({ error: "Use a name between 2 and 120 characters" }, 400);
  }
  if (isSafeId(event.id)) {
    const record = await readJson<CollectionRecord>(env.PHOTOS, collectionKey(event.id));
    if (!record) return json({ error: "No such event" }, 404);
    const key = `site/recent-events/${event.id}`;
    const setting = await readJson<Record<string, unknown>>(env.PHOTOS, key);
    await writeJson(env.PHOTOS, key, { ...setting, eventName: title });
    return json({ renames: await readRenames(env) });
  }
  const renames = await readRenames(env);
  if (title === eventTitle(pastEvents.find((e) => e.id === event.id)!)) delete renames[event.id];
  else renames[event.id] = title;
  await writeJson(env.PHOTOS, PAST_EVENTS_KEY, { renames });
  return json({ renames });
}

const HOME_COVER_KEY = "site/home-cover.json";

type HomeCover = { coverUrl: string | null; collectionId: string | null; photoId: string | null };

/**
 * The photo behind "Open recent event" on the home page. If the photo or its
 * event has since gone to the recycle bin, the card simply shows no image.
 */
async function readHomeCover(env: MediaEnv, isAdmin = false): Promise<HomeCover> {
  const none: HomeCover = { coverUrl: null, collectionId: null, photoId: null };
  const record = await readJson<{ collectionId: string; photoId: string }>(env.PHOTOS, HOME_COVER_KEY);
  if (!record || !isSafeId(record.collectionId) || !isSafeId(record.photoId)) return none;
  if (!isAdmin && await collectionHidden(env, record.collectionId)) return none;
  const [event, photo] = await Promise.all([
    env.PHOTOS.head(collectionKey(record.collectionId)),
    env.PHOTOS.head(photoMetaKey(record.collectionId, record.photoId)),
  ]);
  if (!event || !photo) return none;
  return {
    coverUrl: mediaUrl(record.collectionId, record.photoId, "t"),
    collectionId: record.collectionId,
    photoId: record.photoId,
  };
}

async function setHomeCover(request: Request, env: MediaEnv): Promise<Response> {
  let body: { collectionId?: unknown; photoId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "Malformed body" }, 400);
  }
  const { collectionId, photoId } = body;
  if (typeof collectionId !== "string" || typeof photoId !== "string" || !isSafeId(collectionId) || !isSafeId(photoId)) {
    return json({ error: "Bad id" }, 400);
  }
  if (!(await env.PHOTOS.head(photoMetaKey(collectionId, photoId)))) {
    return json({ error: "No such photo" }, 404);
  }
  await writeJson(env.PHOTOS, HOME_COVER_KEY, { collectionId, photoId, setAt: Date.now() });
  return json(await readHomeCover(env));
}

/**
 * Stores fingerprints the console computed, so the next duplicate check only
 * reads photos uploaded since. Anything malformed is ignored rather than
 * refused, because one bad entry should not cost the other four hundred.
 */
async function saveFingerprints(request: Request, env: MediaEnv, cid: string): Promise<Response> {
  let body: { items?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "Malformed body" }, 400);
  }
  const items = Array.isArray(body.items) ? body.items.slice(0, 500) : [];
  const valid = items.filter(
    (i): i is { photoId: string; fingerprint: string } =>
      !!i && typeof i === "object" && isSafeId((i as { photoId?: unknown }).photoId as string) &&
      isFingerprint((i as { fingerprint?: unknown }).fingerprint),
  );
  const results = await mapLimit(valid, READ_CONCURRENCY, async ({ photoId, fingerprint }) => {
    const key = photoMetaKey(cid, photoId);
    const meta = await readJson<PhotoMeta>(env.PHOTOS, key);
    if (!meta) return false;
    if (meta.fingerprint !== fingerprint) await writeJson(env.PHOTOS, key, { ...meta, fingerprint });
    return true;
  });
  return json({ saved: results.filter(Boolean).length });
}

/**
 * Renames an event. Only the name changes; every photograph, face and search
 * result stays attached to the event's id, which never changes.
 */
async function renameCollection(request: Request, env: MediaEnv, cid: string): Promise<Response> {
  let body: { name?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "Malformed body" }, 400);
  }
  const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
  if (name.length < 2) return json({ error: "Give the event a name of at least 2 characters" }, 400);
  if (name.length > 120) return json({ error: "Keep the name under 120 characters" }, 400);

  const record = await readJson<CollectionRecord>(env.PHOTOS, collectionKey(cid));
  if (!record) return json({ error: "Unknown event" }, 404);
  if (record.id === record.showcaseEventId) {
    const key = `site/recent-events/${record.id}`;
    const setting = await readJson<Record<string, unknown>>(env.PHOTOS, key);
    if (typeof setting?.["eventName"] !== "string") {
      await writeJson(env.PHOTOS, key, { ...setting, eventName: record.name });
    }
  }
  const updated: CollectionRecord = { ...record, name };
  await writeJson(env.PHOTOS, collectionKey(cid), updated);
  return json(updated);
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
  let body: { name?: unknown; description?: unknown; recent?: unknown; eventId?: unknown } | null;
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "Malformed body" }, 400);
  }
  if (!body || typeof body.name !== "string"
    || (body.recent !== undefined && typeof body.recent !== "boolean")
    || (body.eventId !== undefined && typeof body.eventId !== "string")) {
    return json({ error: "Invalid event details" }, 400);
  }
  const name = body.name.trim();
  if (!name) return json({ error: "A collection needs a name" }, 400);

  const eventId = typeof body.eventId === "string" ? body.eventId.trim() : null;
  if (body.eventId !== undefined && !eventId) return json({ error: "Choose an event for this subfolder" }, 400);
  let collections: CollectionRecord[] = [];
  if (eventId) {
    collections = await collectionRecords(env);
    const event = (await readShowcase(env, collections)).find((candidate) => candidate.id === eventId);
    if (!event) return json({ error: "This event is no longer available" }, 404);
    const duplicate = collections.some((collection) =>
      !collection.containerOnly
      && (collection.showcaseEventId ?? LEGACY_RECENT_EVENT_ID) === eventId
      && collection.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase());
    if (duplicate) return json({ error: "That subfolder already exists in this event" }, 409);
  }

  const record: CollectionRecord = {
    id: crypto.randomUUID(),
    name: name.slice(0, 120),
    description: typeof body.description === "string" ? body.description.trim().slice(0, 400) || null : null,
    coverPhotoId: null,
    createdBy: userId,
    createdAt: Date.now(),
  };
  record.showcaseEventId = eventId ?? record.id;
  if (!eventId) record.recent = body.recent !== false;
  await writeJson(env.PHOTOS, collectionKey(record.id), record);
  if (!eventId) {
    await writeJson(env.PHOTOS, `site/recent-events/${record.id}`, {
      eventName: record.name,
      recent: record.recent,
    });
  }

  // A newly created custom event starts as an empty album. On its first
  // subfolder, turn that starter into the event container so members see only
  // useful folders such as Day 1 and Day 2.
  if (eventId) {
    const root = collections.find((collection) =>
      collection.id === eventId && collection.showcaseEventId === eventId && !collection.containerOnly);
    if (root) {
      const key = `site/recent-events/${eventId}`;
      const setting = await readJson<Record<string, unknown>>(env.PHOTOS, key);
      if (typeof setting?.["eventName"] !== "string") {
        await writeJson(env.PHOTOS, key, { ...setting, eventName: root.name });
      }
    }
    if (root && await countPhotos(env.PHOTOS, root.id) === 0) {
      await writeJson(env.PHOTOS, collectionKey(root.id), { ...root, containerOnly: true });
    }
  }
  return json(record, 201);
}

/* --------------------------------- photos --------------------------------- */

async function listPhotos(
  env: MediaEnv,
  cid: string,
  cursor: string | null,
  limit: string | null,
  filename = "",
): Promise<Response> {
  const prefix = `meta/photo/${cid}/`;
  const requested = Number(limit ?? 40);
  const pageSize = Number.isFinite(requested) ? Math.min(50, Math.max(20, Math.floor(requested))) : 40;
  const page = await env.PHOTOS.list({
    prefix,
    limit: pageSize,
    ...(cursor ? { cursor } : {}),
  });

  const records = await mapLimit(page.objects, READ_CONCURRENCY, (o) =>
    readJson<PhotoMeta>(env.PHOTOS, o.key),
  );

  const photos = records
    .filter((p): p is PhotoMeta => p !== null)
    .filter((p) => !filename || p.fileName.toLowerCase().includes(filename.toLowerCase()))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((p) => ({
      id: p.id,
      fileName: p.fileName,
      width: p.width,
      height: p.height,
      facesCount: p.facesCount,
      createdAt: p.createdAt,
      fingerprint: p.fingerprint ?? null,
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
const GOOGLE_STATE_COOKIE = "vayam_google_state";

function randomBase64Url(bytes = 32): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const b of values) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function googleRedirectUri(request: Request, env: MediaEnv): string {
  if (env.GOOGLE_REDIRECT_URI) return env.GOOGLE_REDIRECT_URI;
  const url = new URL(request.url);
  return `${url.origin}/api/auth/google/callback`;
}

function oauthStateCookie(state: string, secure: boolean): string {
  return [
    `${GOOGLE_STATE_COOKIE}=${state}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : null,
    "Max-Age=600",
  ]
    .filter(Boolean)
    .join("; ");
}

function clearOauthStateCookie(secure: boolean): string {
  return [
    `${GOOGLE_STATE_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : null,
    "Max-Age=0",
  ]
    .filter(Boolean)
    .join("; ");
}

function redirectToAuthError(error: string, secure: boolean): Response {
  const headers = new Headers({ location: `/auth?mode=in&error=${encodeURIComponent(error)}` });
  headers.append("set-cookie", clearOauthStateCookie(secure));
  return new Response(null, { status: 302, headers });
}

async function handleAuth(request: Request, env: MediaEnv, rest: string[]): Promise<Response> {
  const action = rest[0] ?? "";
  if (!env.SESSION_SECRET) return json({ error: "SESSION_SECRET is not configured" }, 500);

  const secure = isSecureRequest(request);

  if (action === "google") {
    if (rest[1] === "callback") return handleGoogleCallback(request, env, secure);
    return handleGoogleStart(request, env, secure);
  }

  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

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

  if (action === "reset-password") {
    const phone = normalisePhone(body.phone ?? "");
    const errors: { email?: string; phone?: string; password?: string } = {};
    const emailError = validateEmail(email);
    const phoneError = validatePhone(phone);
    const passwordError = validatePassword(password);
    if (emailError) errors.email = emailError;
    if (phoneError) errors.phone = phoneError;
    if (passwordError) errors.password = passwordError;
    if (Object.keys(errors).length > 0) return json({ error: "Check the form", errors }, 400);

    const member = await getMemberByEmail(env.PHOTOS, email);
    if (!member || !member.phone || member.phone !== phone) {
      return json({ error: "Those details do not match an account" }, 401);
    }

    await putMember(env.PHOTOS, {
      ...member,
      passwordHash: await hashPassword(password),
      authProvider: "password",
    });
    return json({ ok: true });
  }

  return json({ error: "Not found" }, 404);
}

export async function handleGoogleRedirectCallback(
  request: Request,
  env: MediaEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/" || !url.searchParams.get("state")) return null;
  if (!url.searchParams.get("code") && !url.searchParams.get("error")) return null;
  const secure = isSecureRequest(request);
  try {
    return await handleGoogleCallback(request, env, secure);
  } catch (error) {
    console.error("[auth] Google root callback failed", error);
    return redirectToAuthError("google-callback", secure);
  }
}

async function handleGoogleStart(
  request: Request,
  env: MediaEnv,
  secure: boolean,
): Promise<Response> {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return redirectToAuthError("google-config", secure);
  }

  const state = randomBase64Url();
  const target = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  target.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  target.searchParams.set("redirect_uri", googleRedirectUri(request, env));
  target.searchParams.set("response_type", "code");
  target.searchParams.set("scope", "openid email profile");
  target.searchParams.set("state", state);
  target.searchParams.set("prompt", "select_account");

  return new Response(null, {
    status: 302,
    headers: {
      location: target.toString(),
      "set-cookie": oauthStateCookie(state, secure),
    },
  });
}

type GoogleTokenResponse = {
  access_token?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

type GoogleUserInfo = {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
};

async function handleGoogleCallback(
  request: Request,
  env: MediaEnv,
  secure: boolean,
): Promise<Response> {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret) return json({ error: "SESSION_SECRET is not configured" }, 500);
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return redirectToAuthError("google-config", secure);
  }

  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const expectedState = readCookie(request, GOOGLE_STATE_COOKIE);
  if (!state || !expectedState || state !== expectedState) {
    return redirectToAuthError("google-state", secure);
  }
  if (!code || url.searchParams.get("error")) {
    return redirectToAuthError("google-cancelled", secure);
  }

  let tokenRes: Response;
  try {
    tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: googleRedirectUri(request, env),
      }),
    });
  } catch (error) {
    console.error("[auth] Google token request failed", error);
    return redirectToAuthError("google-token", secure);
  }
  const token = (await tokenRes.json().catch(() => ({}))) as GoogleTokenResponse;
  if (!tokenRes.ok || !token.access_token) {
    console.error("[auth] Google token exchange failed", token.error ?? token.error_description);
    return redirectToAuthError("google-token", secure);
  }

  let profileRes: Response;
  try {
    profileRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
  } catch (error) {
    console.error("[auth] Google profile request failed", error);
    return redirectToAuthError("google-profile", secure);
  }
  const profile = (await profileRes.json().catch(() => ({}))) as GoogleUserInfo;
  if (
    !profileRes.ok ||
    !profile.sub ||
    !profile.email ||
    profile.email_verified !== true
  ) {
    return redirectToAuthError("google-profile", secure);
  }

  let member = await getMemberByGoogleSub(env.PHOTOS, profile.sub);
  if (!member) {
    const existing = await getMemberByEmail(env.PHOTOS, profile.email);
    if (existing) {
      member = await linkGoogleMember(env.PHOTOS, existing, profile.sub);
      if (!member) return redirectToAuthError("google-linked", secure);
    } else {
      const created = await createGoogleMember(env.PHOTOS, {
        email: profile.email,
        fullName: profile.name ?? "",
        googleSub: profile.sub,
      });
      if (!created.ok) return redirectToAuthError("google-create", secure);
      member = created.member;
    }
  } else {
    member = { ...member, lastSignInAt: Date.now() };
    await putMember(env.PHOTOS, member).catch(() => undefined);
  }

  const withRole = await ensureRole(env.PHOTOS, member, env.ADMIN_EMAIL);
  const session = await createSessionToken(withRole.id, sessionSecret);
  const headers = new Headers({ location: "/home" });
  headers.append("set-cookie", clearOauthStateCookie(secure));
  headers.append("set-cookie", sessionCookieHeader(session, { secure }));
  return new Response(null, { status: 302, headers });
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

  // The reference crop goes with the profile it belongs to. It is the only
  // photograph of the member the app holds, and "remove my face profile" has to
  // mean it is gone, not that the numbers went and the picture stayed.
  await env.PHOTOS.delete(facePhotoKey(member.id)).catch(() => undefined);

  // So do any waiting rows, which carry their name and phone number.
  const waitingRows: string[] = [];
  let waitingCursor: string | undefined;
  do {
    const page = await env.PHOTOS.list({ prefix: "waiting/", cursor: waitingCursor, limit: 1000 });
    for (const o of page.objects) {
      if (o.key.endsWith("/" + member.id)) waitingRows.push(o.key);
    }
    waitingCursor = page.truncated ? page.cursor : undefined;
  } while (waitingCursor);
  if (waitingRows.length) await env.PHOTOS.delete(waitingRows);

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
  const currentRows = await mapLimit(rows.filter((r): r is WaitingRecord => r !== null), READ_CONCURRENCY, async (row) => {
    const member = await getMemberById(env.PHOTOS, row.userId);
    const hasEmbeddings = member?.references?.some((ref) => ref.length === DESCRIPTOR_DIM) ?? false;
    const hasImage = member ? !!(await env.PHOTOS.head(facePhotoKey(row.userId))) : false;
    return { ...row, hasReference: hasEmbeddings || hasImage };
  });
  const waiting = currentRows
    .sort((a, b) => b.lastAskedAt - a.lastAskedAt);

  return json({ waiting });
}

/* -------------------------------------------------------------------------- */
/*                                 Recycle bin                                */
/* -------------------------------------------------------------------------- */

/**
 * The console's view of the recycle bin. The bin itself lives beside the photo
 * storage in media.server.ts; this only routes to it.
 *
 *   GET  /api/bin                  every entry, newest first
 *   GET  /api/bin/{entry}          one entry with all of its photos
 *   POST /api/bin/{entry}/restore  { photos?: [...] } back to the event
 *   POST /api/bin/{entry}/delete   { photos?: [...] } gone for good
 */
async function handleBin(request: Request, env: MediaEnv, rest: string[]): Promise<Response> {
  const [id, action] = rest;
  try {
    if (request.method === "GET" && !id) {
      // Opening the bin also clears anything past its thirty days, so nothing
      // outstays its welcome even if a scheduled run never fired.
      await purgeExpired(env).catch((e) => console.error("[bin] clearing on open failed", e));
      return json({ groups: await listBin(env) });
    }
    if (!id || !isBinId(id)) return json({ error: "Unknown recycle bin entry" }, 400);

    if (request.method === "GET" && !action) {
      const group = await readBinGroup(env, id);
      if (!group) return json({ error: "That item is no longer in the recycle bin" }, 404);
      return json({ group, photos: await binPhotos(env, group) });
    }

    if (request.method === "POST" && (action === "restore" || action === "delete")) {
      let body: { photos?: unknown } = {};
      try {
        body = (await request.json()) as typeof body;
      } catch {
        // No body means the whole entry.
      }
      const only = Array.isArray(body.photos)
        ? body.photos.filter((p): p is string => typeof p === "string" && isSafeId(p))
        : undefined;
      return json(
        action === "restore" ? await restoreFromBin(env, id, only) : await deleteForever(env, id, only),
      );
    }
    return json({ error: "Not found" }, 404);
  } catch (e) {
    if (e instanceof BinError) return json({ error: e.message }, e.status);
    throw e;
  }
}

/** Read-only admin export search: never changes a profile, cached scan or waiting row. */
async function adminPhotoSearch(request: Request, env: MediaEnv): Promise<Response> {
  let body: { collectionId?: unknown; userId?: unknown; references?: unknown };
  try {
    body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
  } catch {
    return json({ error: "Malformed body" }, 400);
  }
  const cid = body.collectionId;
  if (typeof cid !== "string" || !isSafeId(cid)) return json({ error: "Choose an event" }, 400);
  const collection = await readJson<CollectionRecord>(env.PHOTOS, collectionKey(cid));
  if (!collection) return json({ error: "This event is no longer available. Choose a current event.", code: "no-event" }, 404);
  if ((body.userId !== undefined) === (body.references !== undefined)) {
    return json({ error: "Supply either a member or a reference photo" }, 400);
  }
  let references = body.references;
  if (body.userId !== undefined) {
    if (typeof body.userId !== "string" || !isSafeId(body.userId)) return json({ error: "Invalid member" }, 400);
    const target = await getMemberById(env.PHOTOS, body.userId);
    if (!target) return json({ error: "This member no longer exists" }, 404);
    references = target.references;
  }
  if (!Array.isArray(references) || references.length < 1 || references.length > 8 ||
    !references.every((r) => Array.isArray(r) && r.length === DESCRIPTOR_DIM &&
      r.every((v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1) &&
      r.some((v) => v !== 0))) {
    return json({ error: "A current face reference is required. Choose a clear photo of this person.", code: "no-face" }, 400);
  }
  if (!env.FACE_INDEX) return json({ error: "The face index is unavailable in this environment", code: "no-index" }, 503);
  const outcome = await searchCollection(env.FACE_INDEX, {
    collectionId: cid, references, threshold: MATCH_MAX_DISTANCE,
  });
  const candidates = await mapLimit(outcome.matches, READ_CONCURRENCY, async (match) => {
    const confidence = confidenceFor(match.distance, match.hops);
    if (confidence < CONFIDENT_THRESHOLD || !isSafeId(match.photoId)) return null;
    const photo = await readJson<PhotoMeta>(env.PHOTOS, photoMetaKey(cid, match.photoId));
    if (!photo) return null;
    return {
      photoId: match.photoId, confidence, hops: match.hops,
      fileName: photo.fileName, width: photo.width, height: photo.height,
      thumbUrl: mediaUrl(cid, match.photoId, "t"), fullUrl: mediaUrl(cid, match.photoId),
    };
  });
  const hits = candidates.filter((hit): hit is NonNullable<typeof hit> => hit !== null);
  hits.sort((a, b) => b.confidence - a.confidence);
  return json({ hits, truncated: outcome.truncated, collectionName: collection.name });
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
  if (!(await env.PHOTOS.head(collectionKey(cid)))) {
    return json({ error: "This event is not available any more", code: "no-event" }, 404);
  }

  const member = await getMemberById(env.PHOTOS, userId);
  if (!member) return json({ error: "No such member" }, 401);

  if (member.role !== "admin" && await collectionHidden(env, cid)) return json({ error: "This event is not available", code: "no-event" }, 404);

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
