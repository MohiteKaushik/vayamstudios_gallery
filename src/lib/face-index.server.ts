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
 * Faces are spread over this many namespaces per collection so one round can
 * return SHARD_COUNT * TOP_K candidates rather than TOP_K.
 */
export const SHARD_COUNT = 4;

/**
 * How close a candidate must be to an already-confirmed face to be linked to
 * it. Tighter than the seed threshold because error compounds along a chain.
 */
export const LINK_MAX_DISTANCE = 0.46;

/**
 * Hops beyond the first must be vouched for by this many distinct confirmed
 * faces. This is the guard that keeps a look-alike out. Relaxing the link
 * threshold to 0.50 with this guard in place still admitted genuine
 * doppelgangers in testing, which is why the link stays at 0.46.
 */
export const MIN_SUPPORT = 2;

/**
 * Expansion rounds after the seed round.
 *
 * Chosen by sweeping rounds, frontier size, link threshold and support against
 * 15 independent simulated collections. Four rounds is where profile recall
 * saturates; fewer leaves turned-away shots behind, more only costs latency.
 */
export const DEFAULT_ROUNDS = 4;

/** Probes carried into each expansion round, closest first. */
export const MAX_FRONTIER = 40;

/**
 * Probes fired at once. Each probe costs SHARD_COUNT queries, so this caps
 * in-flight index calls at PROBE_CONCURRENCY * SHARD_COUNT. Kept modest so one
 * member's search cannot monopolise a Worker's outbound budget when two
 * hundred of them arrive together.
 */
export const PROBE_CONCURRENCY = 10;

/** Runs a bounded number of async jobs at a time, preserving nothing but completion. */
async function inBatches<T>(items: T[], size: number, job: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(job));
  }
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

  // Vectorize accepts up to 1000 vectors per upsert from a Worker.
  for (let i = 0; i < vectors.length; i += 1000) {
    await index.upsert(vectors.slice(i, i + 1000));
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
    const vectors = await index.getByIds(probes.map((p) => p.faceId));
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
  await index.deleteByIds(ids);
}
