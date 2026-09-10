/**
 * Face recognition engine.
 *
 * Runs entirely on the user's device: detection, 128-d embedding generation and
 * embedding comparison. No image or biometric data is sent to a third party.
 *
 * The public surface below (`detectFaces`, `detectFacesThorough`, `compare`,
 * `MATCH_MAX_DISTANCE`) is intentionally provider-agnostic, so a server-side or
 * third-party provider can be swapped in behind these functions without
 * touching any UI code.
 *
 * ON FINDING FACES AT ALL
 *
 * The order of failure in a photo gallery is: a face is missed by the detector,
 * or it is detected too small to embed reliably, or it is embedded but at an
 * angle no single threshold reaches. Only the third of those is a matching
 * problem. The first two are detection problems, and no amount of clever
 * searching recovers a face that was never in the index.
 *
 * Event photography makes the first two the common case. A 6000px frame scaled
 * to a single 1024px pass turns a person standing a few metres back into a
 * 30px face: below the size where the embedding means anything, so it is
 * dropped before matching begins. `detectFacesThorough` exists for that, and
 * looks at each photo several times over.
 */

// Explicit .ts extension so the test scripts can run this module directly
// under node --experimental-strip-types. Vite resolves it unchanged.
import { downscale, mirror } from "./images.ts";

const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model";

/**
 * Euclidean distance threshold: how close a face must be to a member's own
 * reference before it is called the same person.
 *
 * Set from the photographs rather than from the library default of 0.6, by
 * pulling every descriptor out of the live collections, taking the face that
 * attracted the most others, and looking at the crops it returned in distance
 * order. In a collection of guests at one event, the first genuine stranger
 * appeared at 0.349 and several more by 0.36, all of them large, sharply
 * focused faces rather than distant ones that a size filter would have caught.
 * The nearest true match sat at 0.333. There is no gap between the two, only a
 * boundary, and 0.34 was where it fell.
 *
 * It was set to 0.10 for a day, at the studio’s instruction, and that is left
 * recorded here because the measurement is the useful part: at 0.10 nobody
 * found anything, which is what the numbers below predicted and what happened.
 * It is back at 0.34 while the descriptor itself is replaced, which is the only
 * change that actually moves both precision and recall at once.
 *
 * The 0.10 measurement, well inside that boundary,
 * after wrong people were still getting through at 0.34. What 0.10 means on
 * these photographs, measured across the live collections by using every face
 * in turn as a reference:
 *
 *   collection    references that find nothing    at 0.34
 *   demo                     33 of 33               20 of 33
 *   event                    60 of 72               55 of 72
 *   portraits                29 of 53               17 of 53
 *
 * At this distance a photograph matches a member only when it is very nearly
 * the same image, so most members will find nothing at all. That is the cost of
 * being certain with a 128-dimension descriptor, and it was chosen knowingly.
 * Raising this one number is the whole of the change if that proves too strict.
 *
 * The consequence is deliberate and worth stating plainly: this is tight enough
 * that a member photographed from an unusual angle will be missed. That was the
 * instruction. Guests being shown photographs of other people is the failure
 * that matters, and at 0.46 it happened on every scan.
 *
 * It follows that this alone cannot reach a turned head, and neither can
 * widening it, because strangers arrive long before the profile does. See the
 * note in face-index.server.ts for why the graph expansion cannot rescue that
 * either on photographs like these.
 */
export const MATCH_MAX_DISTANCE = 0.34;

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

/**
 * Detector confidence floor. Below the library's usual 0.5 because a turned or
 * partly shadowed head scores lower than a posed one, and those are exactly the
 * faces being lost. A spurious detection costs one unmatched vector; a missed
 * real face costs a photo the member never sees.
 */
export const DETECT_MIN_CONFIDENCE = 0.35;

/** Boxes overlapping more than this are treated as the same face across passes. */
const DEDUPE_IOU = 0.35;

/** Fraction each tile overlaps its neighbour, so a face on a seam is not cut in half. */
const TILE_OVERLAP = 0.18;

type FaceApi = typeof import("@vladmandic/face-api");
let apiPromise: Promise<FaceApi> | null = null;

export function loadEngine(): Promise<FaceApi> {
  if (!apiPromise) {
    apiPromise = (async () => {
      const faceapi = (await import(
        "@vladmandic/face-api/dist/face-api.esm.js"
      )) as unknown as FaceApi;
      const tf = faceapi.tf as unknown as {
        setBackend: (b: string) => Promise<boolean>;
        ready: () => Promise<void>;
      };
      await tf.setBackend("webgl").catch(() => tf.setBackend("cpu"));
      await tf.ready();
      await Promise.all([
        faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
      ]);
      return faceapi;
    })().catch((e) => {
      apiPromise = null;
      throw e;
    });
  }
  return apiPromise;
}

export type Box = { x: number; y: number; width: number; height: number };

export type DetectedFace = {
  descriptor: number[];
  box: Box;
  score: number;
  /** Long edge of the crop this face was read from. Higher means a better embedding. */
  readAtPx?: number;
};

/** One detection pass over one canvas. */
export async function detectFaces(
  input: HTMLImageElement | HTMLCanvasElement | HTMLVideoElement,
  minConfidence = DETECT_MIN_CONFIDENCE,
) {
  const faceapi = await loadEngine();
  const results = await faceapi
    .detectAllFaces(input as HTMLImageElement, new faceapi.SsdMobilenetv1Options({ minConfidence }))
    .withFaceLandmarks()
    .withFaceDescriptors();

  return results.map<DetectedFace>((r) => ({
    descriptor: Array.from(r.descriptor),
    box: {
      x: Math.round(r.detection.box.x),
      y: Math.round(r.detection.box.y),
      width: Math.round(r.detection.box.width),
      height: Math.round(r.detection.box.height),
    },
    score: r.detection.score,
  }));
}

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
  const { mirrorPass = true, tilePass = true, minConfidence = DETECT_MIN_CONFIDENCE } = options;

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

/** Euclidean distance between two embeddings. Lower = more similar. */
export function distance(a: number[], b: number[]) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/** 0..1 confidence, used for the optional match-details panel only. */
export function similarity(a: number[], b: number[]) {
  return Math.max(0, Math.min(1, 1 - distance(a, b) / 1.1));
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

/** Length of one face-api descriptor. */
export const DESCRIPTOR_DIM = 128;

/**
 * Several references stored in the one array column the schema already has.
 *
 * A member needs more than one reference to be found at an angle, but
 * face_profiles holds a single row per person and the app reads it with
 * maybeSingle(). Concatenating the references keeps both facts true and needs
 * no migration. A legacy row of exactly one descriptor unpacks to one
 * reference, so existing profiles keep working untouched.
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
