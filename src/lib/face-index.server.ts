/**
 * The face pre-index and the pose-tolerant search that runs on top of it.
 *
 * Two problems are solved here, and they are separate.
 *
 * SPEED. Every face is embedded once, when a photo is uploaded, and written to
 * a Vectorize index. A member's search is a handful of approximate
 * nearest-neighbour lookups whose cost does not grow with the size of the
 * library.
 *
 * POSE. A member enrols with one roughly frontal selfie. Their photos from an
 * event include three-quarter turns, profiles and back-lit shots whose
 * embeddings sit far from that selfie, well outside any threshold that is also
 * safe against strangers. Widening the threshold to reach them lets strangers
 * in, so the threshold is not the lever.
 *
 * The lever is that those hard shots are close to the member's OWN easier
 * shots, even when they are far from the selfie. A profile is far from a
 * frontal selfie but near a three-quarter turn, which is near the frontal. So
 * after the first round of confident matches, the search re-queries the index
 * using those matched faces as new probes and walks outward through the
 * collection's own face graph. Every hop stays inside a tight link threshold,
 * so the chain never takes one loose step; it takes several tight ones.
 *
 * Walking a similarity graph drifts if left alone: one bad hop lands on a
 * stranger and everything downstream of it is wrong. Two guards prevent that.
 * A face admitted beyond the first hop must be vouched for by at least
 * MIN_SUPPORT distinct already-confirmed faces, and the walk is bounded to a
 * small number of rounds with a capped frontier.
 *
 * Dimension-agnostic: works with the 128-d face-api descriptors in use today
 * and with 512-d ArcFace embeddings without a change here.
 *
 * Server-only. Never import from a route or a *.functions.ts file; both ship to
 * the client bundle.
 */

import { MATCH_MAX_DISTANCE } from "./face.ts";

/** Vectorize caps topK at 100 when a query asks for neither values nor metadata. */
const TOP_K = 100;
/** Expansion probes need less breadth than the seed round. */
const TOP_K_EXPAND = 60;

/**
 * Namespaces per collection, so the seed round can return SHARD_COUNT * TOP_K
 * candidates rather than being capped at TOP_K.
 *
 * Dropping this to 1 was tried and reverted: it made every probe a single query
 * but cost more than it saved, taking overall recall from 100% to 72% and
 * profile recall from 100% to 23%, because the seed round then truncates on any
 * collection where a member appears in more than a hundred photos.
 *
 * The seed round is only SHARD_COUNT queries in total, so it is cheap. The cost
 * that mattered was the expansion, and that is bounded by the round and
 * frontier settings below instead.
 */
export const SHARD_COUNT = 4;

/**
 * WHAT THESE FOUR SETTINGS ARE FOR, AND WHY THEY ARE CAUTIOUS
 *
 * The expansion walks a collection's own face graph: from faces already
 * confirmed against the member's reference, it looks for their near neighbours,
 * which is how a photograph showing only the side or the back of a head gets
 * found when it is too far from the reference to match directly.
 *
 * The four settings below were originally tuned against the simulation in
 * scripts/test-face-index.ts, which places two different people about 1.26
 * apart. Real photographs are nothing like that far apart. Measured across two
 * of the live collections, the distance between two distinct faces has a median
 * of 0.66 and a maximum of 0.90, so an entire collection of strangers fits
 * inside a band narrower than the simulation's gap between any two people.
 *
 * Chained hops of 0.46 through a band that narrow reach nearly everybody: one
 * face matched 52 of the 53 in a collection, 29 of them directly. The settings
 * are therefore now well inside the measured spread rather than calibrated to
 * the model. Profile recall is lower than the simulation promised. That is the
 * deliberate trade, because showing a member photographs of somebody else is
 * the worse of the two failures.
 */

/**
 * How close a candidate must be to an already-confirmed face to be linked to it.
 *
 * Half the measured median gap between different people, and closer than a seed
 * match needs to be, so a link is a stronger claim than a direct match rather
 * than an equal one.
 */
export const LINK_MAX_DISTANCE = 0.34;

/**
 * Hops beyond the first must be vouched for by this many distinct confirmed
 * faces. This is the guard that keeps a look-alike out: one close neighbour can
 * be a coincidence, three independent ones are much harder to be.
 */
export const MIN_SUPPORT = 3;

/**
 * Expansion rounds after the seed round. Zero: the walk is off.
 *
 * It went from four to one when a scan was issuing 640 queries and taking 44
 * seconds, and from one to none when the crops were finally looked at. Every
 * hop the walk can safely take now lands inside the direct threshold and finds
 * nothing new, and every hop that would find something new crosses into other
 * people. On these photographs a stranger sits 0.35 from a member while a
 * turned-away shot of the member himself sits past 0.6, so the walk has no
 * distance left to work in.
 *
 * The code is kept, and takes a rounds argument, because it is correct and
 * because a stronger embedding would give it room. It is the 128-dimension
 * descriptor that is the limit here, not the algorithm around it.
 */
export const DEFAULT_ROUNDS = 0;

/**
 * Probes carried into the expansion round, closest first.
 *
 * Every probe costs SHARD_COUNT queries against a live service, so this is a
 * latency budget as much as a recall setting. Twelve probes in a single round is
 * about 150 queries for a whole scan, against 644 before.
 */
export const MAX_FRONTIER = 12;

/**
 * Probes fired at once. Each probe costs SHARD_COUNT queries, so this caps
 * in-flight index calls at PROBE_CONCURRENCY * SHARD_COUNT. Kept modest so one
 * member's search cannot monopolise a Worker's outbound budget when two
 * hundred of them arrive together.
 */
export const PROBE_CONCURRENCY = 8;

/** Runs a bounded number of async jobs at a time, preserving nothing but completion. */
async function inBatches<T>(items: T[], size: number, job: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(job));
  }
}

/* -------------------------------------------------------------------------- */
/*                      Limits the service actually enforces                  */
/* -------------------------------------------------------------------------- */

/**
 * Vectorize rejects a getByIds call carrying more than this, and rejects the
 * whole request rather than truncating:
 *
 *   VECTOR_GET_ERROR (code = 40007): too many ids in payload;
 *   max id count is 20, got 34
 *
 * MAX_FRONTIER is larger than this on purpose, because the frontier size is a
 * search-quality decision and should not be dictated by a transport limit. The
 * chunking below keeps the two independent.
 */
export const GET_BY_IDS_LIMIT = 20;

/** Vectors per delete call. Kept well inside anything the service enforces. */
export const DELETE_BY_IDS_LIMIT = 500;

/** Vectors per upsert call, from the documented Workers limit. */
export const UPSERT_LIMIT = 1000;

/**
 * Fetches stored vectors by id, in chunks the service will accept.
 *
 * Chunks are fetched in parallel; they are independent reads and the round
 * trips would otherwise add up across an expansion round.
 */
export async function getByIdsBatched(
  index: VectorizeIndex,
  ids: string[],
): Promise<{ id: string; values: number[] }[]> {
  if (ids.length === 0) return [];

  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += GET_BY_IDS_LIMIT) {
    chunks.push(ids.slice(i, i + GET_BY_IDS_LIMIT));
  }
  const results = await Promise.all(chunks.map((chunk) => index.getByIds(chunk)));
  return results.flat();
}

export type VectorizeIndex = {
  upsert: (vectors: VectorizeVector[]) => Promise<unknown>;
  query: (vector: number[], opts: VectorizeQueryOptions) => Promise<VectorizeMatches>;
  getByIds: (ids: string[]) => Promise<{ id: string; values: number[] }[]>;
  deleteByIds: (ids: string[]) => Promise<unknown>;
};

type VectorizeVector = {
  id: string;
  values: number[];
  namespace?: string;
  metadata?: Record<string, string | number | boolean>;
};

type VectorizeQueryOptions = {
  topK: number;
  namespace?: string;
  returnValues?: boolean;
  returnMetadata?: "none" | "indexed" | "all";
};

type VectorizeMatches = { matches: { id: string; score: number }[] };

/**
 * Which shard a photo's faces belong to. Derived from the photo id so indexing
 * and searching always agree and one photo's faces never straddle namespaces.
 * FNV-1a: cheap, and spreads uuids evenly.
 */
export function shardFor(photoId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < photoId.length; i++) {
    h ^= photoId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % SHARD_COUNT;
}

const namespaceFor = (collectionId: string, shard: number) => `${collectionId}#${shard}`;

/**
 * Vector ids carry the photo id, so a result maps back to a photo with no
 * metadata round-trip. That is what allows topK 100 rather than the topK 50
 * ceiling that applies once metadata is requested. A uuid plus a slot is 39
 * bytes, inside Vectorize's 64-byte limit.
 */
const vectorId = (photoId: string, slot: number) => `${photoId}:${slot}`;
export const photoIdFromVector = (id: string) => id.slice(0, id.lastIndexOf(":"));

/** Embeddings must be unit length for a distance threshold to mean anything stable. */
export function normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const n = Math.sqrt(sum);
  return n > 0 ? v.map((x) => x / n) : v;
}

/**
 * Writes one photo's faces into the index. Runs once, at upload. Nothing here
 * repeats at search time, which is the entire point of a pre-index.
 */
export async function indexPhotoFaces(
  index: VectorizeIndex,
  args: { collectionId: string; photoId: string; descriptors: number[][] },
): Promise<{ indexed: number; ids: string[] }> {
  const { collectionId, photoId, descriptors } = args;
  if (descriptors.length === 0) return { indexed: 0, ids: [] };

  const shard = shardFor(photoId);
  const vectors = descriptors.map((d, slot) => ({
    id: vectorId(photoId, slot),
    values: normalize(d),
    namespace: namespaceFor(collectionId, shard),
  }));

  for (let i = 0; i < vectors.length; i += UPSERT_LIMIT) {
    await index.upsert(vectors.slice(i, i + UPSERT_LIMIT));
  }
  return { indexed: vectors.length, ids: vectors.map((v) => v.id) };
}

export type IndexMatch = {
  photoId: string;
  /** Distance to the nearest reference, or to the confirmed face that linked it in. */
  distance: number;
  /** 0 if matched directly against a reference, 1 or more if reached through the graph. */
  hops: number;
};

export type SearchStats = {
  queries: number;
  rounds: number;
  seedFaces: number;
  linkedFaces: number;
  rejectedForWeakSupport: number;
};

export type SearchOutcome = {
  matches: IndexMatch[];
  /**
   * True when a seed shard filled its topK budget entirely with in-threshold
   * results, meaning real matches were cut off. The interface should say
   * "your closest N" rather than implying the list is complete.
   */
  truncated: boolean;
  stats: SearchStats;
};

type Confirmed = { faceId: string; photoId: string; distance: number; hops: number };

/** Runs every shard of a collection against one probe, in a single wave. */
async function queryAllShards(
  index: VectorizeIndex,
  collectionId: string,
  probe: number[],
  topK: number,
): Promise<{ id: string; score: number }[][]> {
  return Promise.all(
    Array.from({ length: SHARD_COUNT }, async (_, shard) => {
      const r = await index.query(probe, {
        topK,
        namespace: namespaceFor(collectionId, shard),
        returnValues: false,
        returnMetadata: "none",
      });
      return r.matches;
    }),
  );
}

/**
 * The member-facing search.
 *
 * Round 0 matches the member's reference embeddings directly. Later rounds walk
 * outward from what round 0 confirmed, which is what recovers profiles and
 * other hard angles that no single threshold against a frontal selfie reaches.
 */
export async function searchCollection(
  index: VectorizeIndex,
  args: {
    collectionId: string;
    /** One or more reference embeddings for the member. More angles, better recall. */
    references: number[][];
    threshold?: number;
    linkThreshold?: number;
    rounds?: number;
    maxFrontier?: number;
    minSupport?: number;
  },
): Promise<SearchOutcome> {
  const { collectionId } = args;
  const threshold = args.threshold ?? MATCH_MAX_DISTANCE;
  const linkThreshold = args.linkThreshold ?? LINK_MAX_DISTANCE;
  const rounds = args.rounds ?? DEFAULT_ROUNDS;
  const maxFrontier = args.maxFrontier ?? MAX_FRONTIER;
  const minSupport = args.minSupport ?? MIN_SUPPORT;
  const references = args.references.map(normalize);

  const confirmed = new Map<string, Confirmed>();
  /** Candidates seen beyond hop 0, and which confirmed faces vouched for them. */
  const pending = new Map<string, { supporters: Set<string>; best: number }>();

  let queries = 0;
  let truncated = false;

  // ---- round 0: the references themselves ---------------------------------
  for (const reference of references) {
    const shards = await queryAllShards(index, collectionId, reference, TOP_K);
    queries += SHARD_COUNT;
    for (const matches of shards) {
      const inside = matches.filter((m) => m.score <= threshold);
      if (matches.length >= TOP_K && inside.length === matches.length) truncated = true;
      for (const m of inside) {
        const existing = confirmed.get(m.id);
        if (!existing || m.score < existing.distance) {
          confirmed.set(m.id, {
            faceId: m.id,
            photoId: photoIdFromVector(m.id),
            distance: m.score,
            hops: 0,
          });
        }
      }
    }
  }

  const seedFaces = confirmed.size;
  let frontier = [...confirmed.values()];
  let roundsRun = 0;

  // ---- expansion rounds: walk the collection's own face graph --------------
  for (let round = 1; round <= rounds && frontier.length > 0; round++) {
    roundsRun = round;

    const probes = [...frontier].sort((a, b) => a.distance - b.distance).slice(0, maxFrontier);

    // Vectorize returns stored values by id, so probes cost no extra query.
    // It accepts at most GET_BY_IDS_LIMIT per call and rejects the whole
    // request past that, so this is chunked rather than sent in one go.
    const vectors = await getByIdsBatched(index, probes.map((p) => p.faceId));
    const byId = new Map(vectors.map((v) => [v.id, v.values]));

    // Probes run in bounded parallel batches. Run sequentially this loop would
    // be MAX_FRONTIER round-trips deep and blow the latency budget on its own.
    await inBatches(probes, PROBE_CONCURRENCY, async (probe) => {
      const values = byId.get(probe.faceId);
      if (!values) return;

      const shards = await queryAllShards(index, collectionId, values, TOP_K_EXPAND);
      queries += SHARD_COUNT;

      for (const matches of shards) {
        for (const m of matches) {
          if (m.score > linkThreshold) continue;
          if (confirmed.has(m.id)) continue;

          const entry = pending.get(m.id) ?? { supporters: new Set<string>(), best: Infinity };
          entry.supporters.add(probe.faceId);
          entry.best = Math.min(entry.best, m.score);
          pending.set(m.id, entry);
        }
      }
    });

    // Promote only candidates that several confirmed faces agree on. One tight
    // hop is not enough; that is how a walk wanders onto a stranger.
    const admittedThisRound: Confirmed[] = [];
    for (const [faceId, entry] of pending) {
      if (confirmed.has(faceId)) continue;
      if (entry.supporters.size < minSupport) continue;
      const admitted: Confirmed = {
        faceId,
        photoId: photoIdFromVector(faceId),
        distance: entry.best,
        hops: round,
      };
      confirmed.set(faceId, admitted);
      admittedThisRound.push(admitted);
      pending.delete(faceId);
    }

    frontier = admittedThisRound;
  }

  let rejectedForWeakSupport = 0;
  for (const [faceId, entry] of pending) {
    if (!confirmed.has(faceId) && entry.supporters.size < minSupport) rejectedForWeakSupport++;
  }

  // Collapse faces to photos, keeping each photo's best face.
  const byPhoto = new Map<string, IndexMatch>();
  for (const c of confirmed.values()) {
    const existing = byPhoto.get(c.photoId);
    if (
      !existing ||
      c.hops < existing.hops ||
      (c.hops === existing.hops && c.distance < existing.distance)
    ) {
      byPhoto.set(c.photoId, { photoId: c.photoId, distance: c.distance, hops: c.hops });
    }
  }

  const matches = [...byPhoto.values()].sort((a, b) => a.hops - b.hops || a.distance - b.distance);

  return {
    matches,
    truncated,
    stats: {
      queries,
      rounds: roundsRun,
      seedFaces,
      linkedFaces: confirmed.size - seedFaces,
      rejectedForWeakSupport,
    },
  };
}

/**
 * Picks which reference embeddings to keep for a member, given their confirmed
 * matches from a scan.
 *
 * Recall improves most when the stored references cover different angles, so
 * this keeps the ones furthest apart from each other rather than the closest,
 * which would all be near-duplicates of the enrolment selfie. Called after a
 * successful scan. The member does nothing and sees no new screen, and their
 * next search starts from several angles instead of one.
 */
export function pickDiverseReferences(
  existing: number[][],
  candidates: number[][],
  limit: number,
): number[][] {
  const kept = existing.map(normalize);
  const pool = candidates.map(normalize);

  while (kept.length < limit && pool.length > 0) {
    let bestIdx = 0;
    let bestMinDist = -1;
    for (let i = 0; i < pool.length; i++) {
      let minDist = Infinity;
      for (const k of kept) {
        let sum = 0;
        for (let j = 0; j < k.length; j++) sum += (k[j]! - pool[i]![j]!) ** 2;
        minDist = Math.min(minDist, Math.sqrt(sum));
      }
      if (minDist > bestMinDist) {
        bestMinDist = minDist;
        bestIdx = i;
      }
    }
    kept.push(pool[bestIdx]!);
    pool.splice(bestIdx, 1);
  }
  return kept;
}

/** Removes a photo's faces from the index when the photo is deleted. */
export async function removePhotoFaces(
  index: VectorizeIndex,
  args: { photoId: string; faceCount: number },
): Promise<void> {
  if (args.faceCount === 0) return;
  const ids = Array.from({ length: args.faceCount }, (_, slot) => vectorId(args.photoId, slot));
  // Chunked for the same reason as getByIds: the service rejects an oversized
  // payload outright rather than processing what it can.
  for (let i = 0; i < ids.length; i += DELETE_BY_IDS_LIMIT) {
    await index.deleteByIds(ids.slice(i, i + DELETE_BY_IDS_LIMIT));
  }
}
