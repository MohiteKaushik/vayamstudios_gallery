/**
 * Face recognition, on the member's own device.
 *
 * Detection, embedding and comparison all happen in the browser. No photograph
 * and no biometric data is sent anywhere; the server only ever receives the
 * numbers, and the search runs against those.
 *
 * The models live in face-engine.ts and the arithmetic in insightface.ts. This
 * file is what sits on top: how many times to look at one photograph, how to
 * merge what the passes found, and how to compare the results.
 *
 * ON FINDING FACES AT ALL
 *
 * The order of failure in a photo gallery is: a face is missed by the detector,
 * or it is detected too small to embed reliably, or it is embedded but at an
 * angle no single threshold reaches. Only the third is a matching problem. The
 * first two are detection problems, and no amount of clever searching recovers
 * a face that was never in the index.
 *
 * Event photography makes the first two the common case. A 6000px frame handed
 * to a detector that works at 640px turns a guest standing a few metres back
 * into a dozen pixels, well below the size where an embedding means anything.
 * `detectFacesThorough` exists for that, and looks at each photograph several
 * times over: whole, mirrored, and in overlapping tiles at full resolution.
 */

// Explicit .ts extension so the test scripts can run this module directly
// under node --experimental-strip-types. Vite resolves it unchanged.
import { downscale, mirror } from "./images.ts";
import { cosineDistance, EMBEDDING_DIM, type Box } from "./insightface.ts";

export type { Box };

export type { DetectedFace, Source, EngineProgress } from "./face-engine.ts";
import type { DetectedFace, Source } from "./face-engine.ts";

/**
 * The engine is loaded on demand, never at import time.
 *
 * face-engine.ts pulls in onnxruntime-web, which wants a browser. This module
 * is also read by the test suites and, through the constants below, by the
 * Worker, and a static import would drag a WebAssembly runtime into both. The
 * dynamic import keeps the arithmetic usable everywhere and the models where
 * they belong.
 */
const engine = () => import("./face-engine.ts");

/** Downloads and prepares the models. Safe to call repeatedly; loads once. */
export async function loadEngine() {
  return (await engine()).loadEngine();
}

/** Subscribes to model download progress. Returns an unsubscribe function. */
export async function onEngineProgress(fn: (loaded: number, total: number) => void) {
  return (await engine()).onEngineProgress(fn);
}

/** One detection pass over one image, with an embedding for every face found. */
export async function detectFaces(
  source: Source,
  minConfidence?: number,
): Promise<DetectedFace[]> {
  const e = await engine();
  return e.detectFaces(source, minConfidence ?? e.DETECT_MIN_CONFIDENCE);
}

/**
 * How close a face must be to a member's own reference to be called them.
 *
 * Cosine distance between two unit-length ArcFace embeddings: 0 is the same
 * photograph, 1 is unrelated, 2 is opposite. Not Euclidean distance, and not
 * comparable to the numbers this project used before September 2026, when the
 * descriptor was face-api's 128-dimension ResNet-34.
 *
 * Set by rendering the crops in distance order from the three live collections
 * and looking at them, which is the only method that has ever given an honest
 * answer here:
 *
 *   collection    same person up to    nearest different person
 *   demo                      0.169                      0.849
 *   event                     0.385                      0.598
 *   portraits                 0.615    none within the 23 nearest
 *
 * 0.5 sits inside the one narrow gap, between the event collection's furthest
 * true match at 0.385 and its nearest stranger at 0.598. It is also stricter
 * than InsightFace's own guidance, which puts 1:1 operating points at 0.55 to
 * 0.70 in this units.
 *
 * The old descriptor had no such gap at any threshold: a stranger reached a
 * member at 0.349 while that member's own profile shot sat past 0.8. That is
 * what changed, and it is the reason a number this loose is now the safe one.
 */
export const MATCH_MAX_DISTANCE = 0.5;

/**
 * Long edge each detection pass sees.
 *
 * Raised from 1024. The models run at a fixed input size, so this governs how
 * many real pixels a face is described by. Doubling it roughly quadruples the
 * pixel area of every face in the frame, which is the difference between a
 * distant guest being indexed and being invisible.
 */
export const ANALYSIS_MAX_EDGE = 2048;

/** Faces smaller than this (px, on the analysis canvas) give unreliable embeddings. */
export const MIN_FACE_PX = 60;

/** Boxes overlapping more than this are treated as the same face across passes. */
const DEDUPE_IOU = 0.35;

/** Fraction each tile overlaps its neighbour, so a face on a seam is not cut in half. */
const TILE_OVERLAP = 0.18;

/* -------------------------------------------------------------------------- */
/*                          Multi-pass detection                              */
/* -------------------------------------------------------------------------- */

export function iou(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const overlap = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (overlap === 0) return 0;
  return overlap / (a.width * a.height + b.width * b.height - overlap);
}

/**
 * Collapses detections of the same face found by different passes.
 *
 * When two passes disagree, the one that saw more pixels wins, because its
 * embedding is the more trustworthy of the two. Detector score breaks ties.
 */
export function mergeDetections(faces: DetectedFace[]): DetectedFace[] {
  const ranked = [...faces].sort(
    (a, b) => (b.readAtPx ?? 0) - (a.readAtPx ?? 0) || b.score - a.score,
  );
  const kept: DetectedFace[] = [];
  for (const face of ranked) {
    if (kept.some((k) => iou(k.box, face.box) > DEDUPE_IOU)) continue;
    kept.push(face);
  }
  return kept;
}

/** How many tiles per axis are worth cutting, given how much detail is being thrown away. */
export function tileCountFor(sourceMaxEdge: number, analysisEdge = ANALYSIS_MAX_EDGE): number {
  const ratio = sourceMaxEdge / analysisEdge;
  if (ratio < 1.6) return 1; // nothing meaningful is being lost
  return ratio < 2.8 ? 2 : 3;
}

function cropCanvas(
  source: HTMLImageElement | HTMLCanvasElement,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  maxEdge: number,
) {
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return { canvas, scale };
}

export type ThoroughOptions = {
  /** Also scan a mirrored copy. The detector is not left-right symmetric, so this finds extra profiles. */
  mirrorPass?: boolean;
  /** Cut the frame into overlapping tiles and scan each at full analysis resolution. */
  tilePass?: boolean;
  minConfidence?: number;
};

/**
 * Finds as many faces as the model can, then returns them in one coordinate
 * space: the analysis canvas, exactly as the single-pass `detectFaces` would.
 * Callers scale boxes the same way they already did.
 *
 * Costs several model runs per photo. That is paid once, when an admin uploads,
 * and never again at search time.
 */
export async function detectFacesThorough(
  source: HTMLImageElement,
  options: ThoroughOptions = {},
): Promise<{ faces: DetectedFace[]; canvas: HTMLCanvasElement; passes: number }> {
  const { mirrorPass = true, tilePass = true } = options;
  const minConfidence = options.minConfidence ?? (await engine()).DETECT_MIN_CONFIDENCE;

  const base = downscale(source, ANALYSIS_MAX_EDGE);
  const canvas = base.canvas;
  const sourceMaxEdge = Math.max(base.width, base.height);
  /** original pixels -> analysis-canvas pixels */
  const toBase = canvas.width / base.width;

  const found: DetectedFace[] = [];
  let passes = 0;

  // Pass 1: the whole frame.
  passes++;
  for (const f of await detectFaces(canvas, minConfidence)) {
    found.push({ ...f, readAtPx: Math.max(canvas.width, canvas.height) });
  }

  // Pass 2: the whole frame, mirrored. Un-mirror the boxes on the way back.
  // A descriptor read from a mirrored face sits very close to the original in
  // embedding space, so it is a usable stand-in for a face pass 1 missed.
  if (mirrorPass) {
    passes++;
    const flipped = mirror(canvas);
    for (const f of await detectFaces(flipped, minConfidence)) {
      found.push({
        ...f,
        box: { ...f.box, x: canvas.width - f.box.x - f.box.width },
        readAtPx: Math.max(canvas.width, canvas.height),
      });
    }
  }

  // Pass 3: overlapping tiles, each read at full analysis resolution. This is
  // what recovers small and distant faces, which a single downscaled pass
  // renders too coarse to embed.
  const tiles = tilePass ? tileCountFor(sourceMaxEdge) : 1;
  if (tiles > 1) {
    const stepX = base.width / tiles;
    const stepY = base.height / tiles;
    const padX = stepX * TILE_OVERLAP;
    const padY = stepY * TILE_OVERLAP;

    for (let ty = 0; ty < tiles; ty++) {
      for (let tx = 0; tx < tiles; tx++) {
        const sx = Math.max(0, tx * stepX - padX);
        const sy = Math.max(0, ty * stepY - padY);
        const sw = Math.min(base.width - sx, stepX + padX * 2);
        const sh = Math.min(base.height - sy, stepY + padY * 2);

        passes++;
        const tile = cropCanvas(source, sx, sy, sw, sh, ANALYSIS_MAX_EDGE);
        for (const f of await detectFaces(tile.canvas, minConfidence)) {
          // tile pixels -> original pixels -> analysis-canvas pixels
          found.push({
            ...f,
            box: {
              x: Math.round((sx + f.box.x / tile.scale) * toBase),
              y: Math.round((sy + f.box.y / tile.scale) * toBase),
              width: Math.round((f.box.width / tile.scale) * toBase),
              height: Math.round((f.box.height / tile.scale) * toBase),
            },
            readAtPx: Math.max(tile.canvas.width, tile.canvas.height),
          });
        }
      }
    }
  }

  return { faces: mergeDetections(found), canvas, passes };
}

/* -------------------------------------------------------------------------- */
/*                              Comparison                                    */
/* -------------------------------------------------------------------------- */

/**
 * Cosine distance between two embeddings. Lower is more alike.
 *
 * ArcFace is trained with an angular margin, so identity lives in the direction
 * of the vector and nothing else. Its length carries image quality, which is
 * why every embedding is normalised on the way out of the model and why the
 * comparison here is an angle rather than a straight-line distance.
 */
export function distance(a: number[], b: number[]) {
  return cosineDistance(a, b);
}

/** 0..1, where 1 is the same face. Only for showing a member a number. */
export function similarity(a: number[], b: number[]) {
  return Math.max(0, Math.min(1, 1 - distance(a, b)));
}

/** Closest of `faces` to a single reference. */
export function bestMatch(reference: number[], faces: DetectedFace[]) {
  let best: { face: DetectedFace; dist: number } | null = null;
  for (const face of faces) {
    const d = distance(reference, face.descriptor);
    if (!best || d < best.dist) best = { face, dist: d };
  }
  return best;
}

/**
 * Closest distance from a face to ANY of a member's reference embeddings.
 *
 * One selfie describes one angle. Several references, gathered from different
 * angles, is the cheapest real defence against a turned head: the profile that
 * sits 0.8 from a frontal selfie may sit 0.3 from a reference taken at
 * three-quarters.
 */
export function distanceToReferences(references: number[][], descriptor: number[]): number {
  let best = Infinity;
  for (const reference of references) {
    const d = distance(reference, descriptor);
    if (d < best) best = d;
  }
  return best;
}

/** Closest of `faces` to any reference, with the distance that won. */
export function bestMatchMulti(references: number[][], faces: DetectedFace[]) {
  let best: { face: DetectedFace; dist: number } | null = null;
  for (const face of faces) {
    const d = distanceToReferences(references, face.descriptor);
    if (!best || d < best.dist) best = { face, dist: d };
  }
  return best;
}

/** Scales a vector back to unit length. */
export function normalizeDescriptor(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const n = Math.sqrt(sum);
  return n > 0 ? v.map((x) => x / n) : v;
}

/**
 * Mean of several embeddings of the same face, renormalised to unit length.
 *
 * Descriptors come out of the model L2-normalised, and averaging two of them
 * yields a shorter vector, which would pull every later distance downward and
 * quietly widen the match threshold. Renormalising keeps MATCH_MAX_DISTANCE
 * meaning what it says.
 */
export function averageDescriptors(list: number[][]) {
  const first = list[0]!;
  const out = new Array<number>(first.length).fill(0);
  for (const d of list) for (let i = 0; i < out.length; i++) out[i] = out[i]! + (d[i] ?? 0);
  return normalizeDescriptor(out.map((v) => v / list.length));
}

/**
 * Chooses which embeddings to keep as a member's references.
 *
 * Keeps the ones furthest from each other rather than the closest, because
 * near-duplicates of the enrolment selfie add nothing. Coverage of different
 * angles is the whole value of holding more than one.
 */
export function pickDiverseReferences(
  existing: number[][],
  candidates: number[][],
  limit: number,
): number[][] {
  const kept = existing.map(normalizeDescriptor);
  const pool = candidates.map(normalizeDescriptor);

  while (kept.length < limit && pool.length > 0) {
    let bestIdx = 0;
    let bestMinDist = -1;
    for (let i = 0; i < pool.length; i++) {
      let minDist = Infinity;
      for (const k of kept) minDist = Math.min(minDist, distance(k, pool[i]!));
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

/** How many reference embeddings a member may accumulate. */
export const MAX_REFERENCES = 8;

/** Length of one ArcFace embedding. */
export const DESCRIPTOR_DIM = EMBEDDING_DIM;

/**
 * Several references stored in the one array column the schema already has.
 *
 * A member needs more than one reference to be found at an angle, and the
 * record holds a single list per person. Concatenating the references keeps
 * both facts true. Note that a profile stored before September 2026 holds
 * 128-number descriptors from the old model and will not unpack at 512; those
 * members are asked for a new reference photo rather than silently matched
 * against nothing.
 */
export function packReferences(references: number[][]): number[] {
  return references.flat();
}

export function unpackReferences(flat: number[] | null | undefined, dim = DESCRIPTOR_DIM): number[][] {
  if (!flat || flat.length < dim) return [];
  const out: number[][] = [];
  for (let i = 0; i + dim <= flat.length; i += dim) out.push(flat.slice(i, i + dim));
  return out;
}
