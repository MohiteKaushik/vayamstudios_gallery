/**
 * Pose-tolerant face search, run in the browser over a collection's own faces.
 *
 * THE PROBLEM THIS SOLVES
 *
 * A member enrols with a roughly frontal selfie. Their photos from an event
 * include three-quarter turns and profiles whose embeddings sit around 0.8 from
 * that selfie, while a stranger sits around 1.2. There is no threshold that
 * admits the profile and excludes the stranger, so tuning the number cannot
 * work. Comparing every face to the selfie once, which is what the product did
 * before, finds the frontal shots and almost nothing else.
 *
 * THE WAY THROUGH
 *
 * Those hard shots are close to the member's OWN easier shots even while being
 * far from the selfie. A profile is far from a frontal selfie but near a
 * three-quarter turn, which is near the frontal. So after the first round of
 * confident matches, the search re-queries using those matched faces as new
 * probes and walks outward through the collection's own face graph. Every hop
 * stays inside a tight link threshold: the chain never takes one loose step, it
 * takes several tight ones.
 *
 * KEEPING IT HONEST
 *
 * A similarity walk drifts if left alone; one bad hop lands on a stranger and
 * everything downstream is wrong. A face admitted beyond the first hop must be
 * vouched for by at least `minSupport` distinct already-confirmed faces, and
 * the walk is bounded in rounds and frontier size.
 *
 * WHY IT RUNS HERE AND NOT ON A SERVER
 *
 * The whole face set is a few megabytes, and comparing against all of it is
 * exact rather than approximate. There is no top-K ceiling to truncate results,
 * no per-probe network round trip, and no biometric data leaves the device.
 */

/** A collection's faces, packed for fast comparison. */
export type FaceSet = {
  faceIds: string[];
  photoIds: string[];
  /** faceIds.length * dim, unit-length rows. */
  vectors: Float32Array;
  dim: number;
};

export type SearchOptions = {
  references: number[][];
  /** Distance at which a face is the member, compared against a reference. */
  threshold: number;
  /** Tighter distance required to chain one confirmed face to the next. */
  linkThreshold?: number;
  rounds?: number;
  maxFrontier?: number;
  minSupport?: number;
  onProgress?: (round: number, confirmedPhotos: number) => void;
};

export type SearchHit = {
  photoId: string;
  /** Distance to whichever reference or confirmed face brought it in. */
  distance: number;
  /** 0 when matched straight off a reference, higher when reached through the graph. */
  hops: number;
};

export type SearchResult = {
  hits: SearchHit[];
  /**
   * Indices of the faces confirmed as the member. Not the same as the faces in
   * a matched photo: a photo the member is in also contains other people, and
   * treating those as the member is how a reference set gets poisoned.
   */
  confirmedFaces: number[];
  stats: {
    facesScanned: number;
    seedFaces: number;
    linkedFaces: number;
    rejectedForWeakSupport: number;
    rounds: number;
    comparisons: number;
  };
};

export const DEFAULT_LINK_DISTANCE = 0.46;
export const DEFAULT_ROUNDS = 4;
export const DEFAULT_MAX_FRONTIER = 40;
export const DEFAULT_MIN_SUPPORT = 2;

/** Packs rows of descriptors into one contiguous, unit-length buffer. */
export function buildFaceSet(
  rows: { id: string; photo_id: string; descriptor: number[] }[],
): FaceSet {
  const usable = rows.filter((r) => Array.isArray(r.descriptor) && r.descriptor.length > 0);
  const dim = usable[0]?.descriptor.length ?? 128;
  const vectors = new Float32Array(usable.length * dim);
  const faceIds: string[] = [];
  const photoIds: string[] = [];

  usable.forEach((row, i) => {
    faceIds.push(row.id);
    photoIds.push(row.photo_id);
    const offset = i * dim;
    let sum = 0;
    for (let j = 0; j < dim; j++) {
      const v = row.descriptor[j] ?? 0;
      vectors[offset + j] = v;
      sum += v * v;
    }
    // Distances only mean anything against a fixed threshold if every row is
    // unit length. Stored descriptors normally are; averaged ones may not be.
    const norm = Math.sqrt(sum);
    if (norm > 0 && Math.abs(norm - 1) > 1e-6) {
      for (let j = 0; j < dim; j++) vectors[offset + j] = vectors[offset + j]! / norm;
    }
  });

  return { faceIds, photoIds, vectors, dim };
}

/** Distance from a probe to row `i`, with early exit once it cannot win. */
function distanceTo(set: FaceSet, i: number, probe: Float32Array, cutoffSq: number): number {
  const offset = i * set.dim;
  let sum = 0;
  for (let j = 0; j < set.dim; j++) {
    const d = probe[j]! - set.vectors[offset + j]!;
    sum += d * d;
    // Squared distance only grows, so once it passes the cutoff this row is out.
    if (sum > cutoffSq) return Infinity;
  }
  return Math.sqrt(sum);
}

function toUnitFloat32(v: number[]): Float32Array {
  const out = new Float32Array(v.length);
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    out[i] = v[i]!;
    sum += v[i]! * v[i]!;
  }
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = 0; i < out.length; i++) out[i] = out[i]! / norm;
  return out;
}

function rowAsFloat32(set: FaceSet, i: number): Float32Array {
  return set.vectors.subarray(i * set.dim, (i + 1) * set.dim);
}

/**
 * Runs the seed round and the expansion rounds over a packed face set.
 * Exact, not approximate: every face is compared, so nothing is truncated.
 */
export function searchFaceSet(set: FaceSet, options: SearchOptions): SearchResult {
  const {
    references,
    threshold,
    linkThreshold = DEFAULT_LINK_DISTANCE,
    rounds = DEFAULT_ROUNDS,
    maxFrontier = DEFAULT_MAX_FRONTIER,
    minSupport = DEFAULT_MIN_SUPPORT,
    onProgress,
  } = options;

  const n = set.faceIds.length;
  const confirmed = new Map<number, { distance: number; hops: number }>();
  const pending = new Map<number, { supporters: Set<number>; best: number }>();
  let comparisons = 0;

  // ---- round 0: the member's own references ------------------------------
  const seedCutoffSq = threshold * threshold;
  for (const reference of references) {
    const probe = toUnitFloat32(reference);
    for (let i = 0; i < n; i++) {
      comparisons++;
      const d = distanceTo(set, i, probe, seedCutoffSq);
      if (d > threshold) continue;
      const existing = confirmed.get(i);
      if (!existing || d < existing.distance) confirmed.set(i, { distance: d, hops: 0 });
    }
  }

  const seedFaces = confirmed.size;
  let frontier = [...confirmed.entries()].map(([i, v]) => ({ i, distance: v.distance }));
  let roundsRun = 0;
  onProgress?.(0, countPhotos(set, confirmed));

  // ---- expansion: walk the collection's own face graph --------------------
  const linkCutoffSq = linkThreshold * linkThreshold;
  for (let round = 1; round <= rounds && frontier.length > 0; round++) {
    roundsRun = round;

    const probes = [...frontier].sort((a, b) => a.distance - b.distance).slice(0, maxFrontier);

    for (const probe of probes) {
      const vector = rowAsFloat32(set, probe.i);
      for (let i = 0; i < n; i++) {
        if (confirmed.has(i)) continue;
        comparisons++;
        const d = distanceTo(set, i, vector, linkCutoffSq);
        if (d > linkThreshold) continue;
        const entry = pending.get(i) ?? { supporters: new Set<number>(), best: Infinity };
        entry.supporters.add(probe.i);
        if (d < entry.best) entry.best = d;
        pending.set(i, entry);
      }
    }

    // Promote only what several confirmed faces agree on. One tight hop is not
    // enough; that is how a walk wanders onto a look-alike.
    const admitted: { i: number; distance: number }[] = [];
    for (const [i, entry] of pending) {
      if (confirmed.has(i)) continue;
      if (entry.supporters.size < minSupport) continue;
      confirmed.set(i, { distance: entry.best, hops: round });
      admitted.push({ i, distance: entry.best });
      pending.delete(i);
    }

    frontier = admitted;
    onProgress?.(round, countPhotos(set, confirmed));
  }

  let rejectedForWeakSupport = 0;
  for (const [i, entry] of pending) {
    if (!confirmed.has(i) && entry.supporters.size < minSupport) rejectedForWeakSupport++;
  }

  // Collapse faces to photos, keeping each photo's strongest evidence.
  const byPhoto = new Map<string, SearchHit>();
  for (const [i, v] of confirmed) {
    const photoId = set.photoIds[i]!;
    const existing = byPhoto.get(photoId);
    if (
      !existing ||
      v.hops < existing.hops ||
      (v.hops === existing.hops && v.distance < existing.distance)
    ) {
      byPhoto.set(photoId, { photoId, distance: v.distance, hops: v.hops });
    }
  }

  const hits = [...byPhoto.values()].sort((a, b) => a.hops - b.hops || a.distance - b.distance);

  return {
    hits,
    confirmedFaces: [...confirmed.keys()],
    stats: {
      facesScanned: n,
      seedFaces,
      linkedFaces: confirmed.size - seedFaces,
      rejectedForWeakSupport,
      rounds: roundsRun,
      comparisons,
    },
  };
}

function countPhotos(set: FaceSet, confirmed: Map<number, unknown>): number {
  const seen = new Set<string>();
  for (const i of confirmed.keys()) seen.add(set.photoIds[i]!);
  return seen.size;
}

/**
 * Embeddings worth keeping as extra references, taken from a completed scan.
 *
 * The value is angular coverage, so this returns the confirmed faces furthest
 * from what the member already has on file. Next time they scan, the search
 * starts from several angles instead of one, and reaches turned heads in the
 * seed round rather than having to walk to them.
 */
export const MAX_HARVEST_DISTANCE = 0.95;

export function harvestReferences(
  set: FaceSet,
  result: SearchResult,
  existing: number[][],
  limit: number,
): number[][] {
  const kept = existing.map((v) => Array.from(toUnitFloat32(v)));
  if (kept.length === 0 || result.confirmedFaces.length === 0) return kept;

  const dist = (a: number[], b: number[]) => {
    let sum = 0;
    for (let j = 0; j < a.length; j++) sum += (a[j]! - b[j]!) ** 2;
    return Math.sqrt(sum);
  };

  // Only faces the search actually confirmed as this member, and only those
  // still plausibly the same person. A candidate further than this from every
  // reference held is more likely a mistake than a new angle, so it is dropped
  // rather than allowed to drag the reference set off the member.
  const pool = result.confirmedFaces
    .map((i) => Array.from(rowAsFloat32(set, i)))
    .filter((v) => Math.min(...kept.map((k) => dist(k, v))) <= MAX_HARVEST_DISTANCE);

  while (kept.length < limit && pool.length > 0) {
    let bestIdx = 0;
    let bestMinDist = -1;
    for (let i = 0; i < pool.length; i++) {
      const minDist = Math.min(...kept.map((k) => dist(k, pool[i]!)));
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
