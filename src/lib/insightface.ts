/**
 * The InsightFace pipeline, as arithmetic only.
 *
 * Nothing here touches a canvas, a file or an inference session. It takes raw
 * pixels and raw model outputs and gives back boxes, landmarks and aligned
 * crops. That is deliberate: the browser runs this through onnxruntime-web on a
 * canvas, and the validation script in scripts/ runs the very same functions
 * through onnxruntime-node on pixels from sharp. If the two disagreed, a figure
 * measured offline would say nothing about what a member actually gets.
 *
 * Two models, both from the InsightFace buffalo_s pack:
 *
 *   scrfd-500m.onnx           2.5 MB   finds faces, and gives five landmarks
 *   arcface-w600k-mbf.onnx   13.6 MB   turns an aligned face into 512 numbers
 *
 * The pack that replaced face-api.js scores about 98% on CFP-FP, the benchmark
 * built specifically from frontal-versus-profile pairs. The descriptor it
 * replaces is a 2017-era ResNet-34 that was never competitive there, and that
 * gap is the whole reason a member's side-on photograph sat further from their
 * selfie than a stranger's did.
 */

/* -------------------------------------------------------------------------- */
/*                                  Geometry                                  */
/* -------------------------------------------------------------------------- */

export type Point = { x: number; y: number };
export type Box = { x: number; y: number; width: number; height: number };

/**
 * Where ArcFace expects the five landmarks to land in a 112x112 crop.
 *
 * These are not arbitrary. Every face the model was trained on was warped so
 * that the eyes, nose and mouth corners sat at exactly these coordinates, so
 * feeding it a crop aligned any other way is feeding it something it has never
 * seen. Getting this wrong does not throw; it quietly returns embeddings that
 * are worse than useless, which is far harder to notice.
 */
export const ARCFACE_REFERENCE: readonly Point[] = [
  { x: 38.2946, y: 51.6963 }, // left eye
  { x: 73.5318, y: 51.5014 }, // right eye
  { x: 56.0252, y: 71.7366 }, // nose tip
  { x: 41.5493, y: 92.3655 }, // left mouth corner
  { x: 70.7299, y: 92.2041 }, // right mouth corner
];

export const ARCFACE_SIZE = 112;

/** A 2D similarity transform: rotation and uniform scale, then a translation. */
export type Similarity = { a: number; b: number; tx: number; ty: number };

/**
 * The similarity transform that best carries `src` onto `dst`.
 *
 * Least squares over rotation, uniform scale and translation, with reflection
 * excluded. Written out in closed form rather than reached through a singular
 * value decomposition, because for a transform of this shape the closed form is
 * exact, is four lines, and cannot pick the mirrored solution the way a general
 * decomposition can when a face is nearly symmetric.
 *
 * Applying it: u = a*x - b*y + tx, v = b*x + a*y + ty.
 */
export function similarityTransform(src: readonly Point[], dst: readonly Point[]): Similarity {
  const n = Math.min(src.length, dst.length);
  if (n < 2) throw new Error("a similarity transform needs at least two points");

  let sx = 0, sy = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    sx += src[i]!.x; sy += src[i]!.y;
    dx += dst[i]!.x; dy += dst[i]!.y;
  }
  sx /= n; sy /= n; dx /= n; dy /= n;

  let num1 = 0, num2 = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const x = src[i]!.x - sx, y = src[i]!.y - sy;
    const u = dst[i]!.x - dx, v = dst[i]!.y - dy;
    num1 += x * u + y * v;
    num2 += x * v - y * u;
    den += x * x + y * y;
  }
  if (den === 0) throw new Error("the source landmarks are all the same point");

  const a = num1 / den;
  const b = num2 / den;
  return { a, b, tx: dx - (a * sx - b * sy), ty: dy - (b * sx + a * sy) };
}

/** The transform that puts a detected face where ArcFace expects to find it. */
export function alignmentFor(landmarks: readonly Point[]): Similarity {
  return similarityTransform(landmarks, ARCFACE_REFERENCE);
}

/** Inverts a similarity transform, for sampling the source from the destination. */
export function invert({ a, b, tx, ty }: Similarity): Similarity {
  const det = a * a + b * b;
  if (det === 0) throw new Error("this transform cannot be inverted");
  const ia = a / det;
  const ib = -b / det;
  return { a: ia, b: ib, tx: -(ia * tx - ib * ty), ty: -(ib * tx + ia * ty) };
}

/* -------------------------------------------------------------------------- */
/*                            SCRFD, the detector                             */
/* -------------------------------------------------------------------------- */

/**
 * The three feature strides SCRFD reports at, and how many anchors sit on each
 * cell. Both are fixed by the exported graph: a 640x640 input gives 80x80x2,
 * 40x40x2 and 20x20x2 rows, which is the 12800, 3200 and 800 the model returns.
 */
export const SCRFD_STRIDES = [8, 16, 32] as const;
export const SCRFD_ANCHORS_PER_CELL = 2;
export const SCRFD_INPUT = 640;

export type ScrfdRaw = {
  /** Per stride, in the order of SCRFD_STRIDES. */
  scores: Float32Array[];
  /** Per stride: four distances per anchor, left, top, right, bottom. */
  boxes: Float32Array[];
  /** Per stride: five landmark offsets per anchor, x then y. */
  keypoints: Float32Array[];
};

export type Detection = {
  box: Box;
  score: number;
  landmarks: Point[];
};

/**
 * Turns SCRFD's raw grids into boxes in the coordinates of the padded input.
 *
 * The model does not predict a box. It predicts, for each cell of each grid,
 * how far the four edges lie from that cell's centre, in units of the stride,
 * and where the five landmarks sit relative to the same centre. Undoing that is
 * the whole of this function.
 */
export function decodeScrfd(raw: ScrfdRaw, threshold: number): Detection[] {
  const found: Detection[] = [];

  for (let s = 0; s < SCRFD_STRIDES.length; s++) {
    const stride = SCRFD_STRIDES[s]!;
    const scores = raw.scores[s]!;
    const boxes = raw.boxes[s]!;
    const kps = raw.keypoints[s]!;
    const side = SCRFD_INPUT / stride;

    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        for (let anchor = 0; anchor < SCRFD_ANCHORS_PER_CELL; anchor++) {
          const i = (y * side + x) * SCRFD_ANCHORS_PER_CELL + anchor;
          const score = scores[i]!;
          if (score < threshold) continue;

          const cx = x * stride;
          const cy = y * stride;

          const left = boxes[i * 4]! * stride;
          const top = boxes[i * 4 + 1]! * stride;
          const right = boxes[i * 4 + 2]! * stride;
          const bottom = boxes[i * 4 + 3]! * stride;

          const landmarks: Point[] = [];
          for (let k = 0; k < 5; k++) {
            landmarks.push({
              x: cx + kps[i * 10 + k * 2]! * stride,
              y: cy + kps[i * 10 + k * 2 + 1]! * stride,
            });
          }

          found.push({
            score,
            box: {
              x: cx - left,
              y: cy - top,
              width: left + right,
              height: top + bottom,
            },
            landmarks,
          });
        }
      }
    }
  }

  return found;
}

export function iou(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const overlap = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (overlap <= 0) return 0;
  return overlap / (a.width * a.height + b.width * b.height - overlap);
}

/** Keeps the strongest of each cluster of overlapping boxes. */
export function nonMaxSuppression(dets: Detection[], maxIou = 0.4): Detection[] {
  const sorted = [...dets].sort((p, q) => q.score - p.score);
  const kept: Detection[] = [];
  for (const d of sorted) {
    if (kept.some((k) => iou(k.box, d.box) > maxIou)) continue;
    kept.push(d);
  }
  return kept;
}

/**
 * Undoes the letterboxing, so boxes and landmarks come back in the coordinates
 * of the image that was handed in rather than of the 640x640 square it was
 * padded into.
 */
export function rescale(dets: Detection[], scale: number): Detection[] {
  return dets.map((d) => ({
    score: d.score,
    box: {
      x: d.box.x / scale,
      y: d.box.y / scale,
      width: d.box.width / scale,
      height: d.box.height / scale,
    },
    landmarks: d.landmarks.map((p) => ({ x: p.x / scale, y: p.y / scale })),
  }));
}

/* -------------------------------------------------------------------------- */
/*                              Pixels to tensors                             */
/* -------------------------------------------------------------------------- */

/**
 * SCRFD's input: RGB, (v - 127.5) / 128, planar.
 *
 * `rgb` is tightly packed three-channel data for a `width` by `height` image
 * that has already been scaled to fit inside 640x640. The rest of the square is
 * left at the padding value, which after this normalisation is what the model
 * was trained to see in the empty region.
 */
export function scrfdTensor(rgb: Uint8Array, width: number, height: number): Float32Array {
  const side = SCRFD_INPUT;
  const out = new Float32Array(3 * side * side);
  const plane = side * side;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 3;
      const dst = y * side + x;
      out[dst] = (rgb[src]! - 127.5) / 128;
      out[plane + dst] = (rgb[src + 1]! - 127.5) / 128;
      out[2 * plane + dst] = (rgb[src + 2]! - 127.5) / 128;
    }
  }
  return out;
}

/**
 * ArcFace's input: RGB, (v - 127.5) / 127.5, planar, from a 112x112 crop.
 *
 * Note the divisor differs from the detector's by half a unit. That is not a
 * transcription slip; the two models were exported with different scaling, and
 * carrying the detector's over to the recogniser costs real accuracy silently.
 */
export function arcfaceTensor(rgb: Uint8Array): Float32Array {
  const side = ARCFACE_SIZE;
  const plane = side * side;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    out[i] = (rgb[i * 3]! - 127.5) / 127.5;
    out[plane + i] = (rgb[i * 3 + 1]! - 127.5) / 127.5;
    out[2 * plane + i] = (rgb[i * 3 + 2]! - 127.5) / 127.5;
  }
  return out;
}

/**
 * Warps a face out of a full frame into the 112x112 ArcFace expects.
 *
 * Bilinear, sampling the source for every destination pixel through the
 * inverted transform, which is the same thing a canvas does when it draws under
 * a transform. Having it written out means the validation script and the
 * browser produce the same crop rather than merely a similar one.
 */
export function warpToArcface(
  rgb: Uint8Array,
  width: number,
  height: number,
  transform: Similarity,
): Uint8Array {
  const side = ARCFACE_SIZE;
  const out = new Uint8Array(side * side * 3);
  const inv = invert(transform);

  for (let v = 0; v < side; v++) {
    for (let u = 0; u < side; u++) {
      const sx = inv.a * u - inv.b * v + inv.tx;
      const sy = inv.b * u + inv.a * v + inv.ty;

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const dst = (v * side + u) * 3;

      for (let c = 0; c < 3; c++) {
        const at = (px: number, py: number) => {
          if (px < 0 || py < 0 || px >= width || py >= height) return 0;
          return rgb[(py * width + px) * 3 + c]!;
        };
        const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
        const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
        out[dst + c] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*                                 Embeddings                                 */
/* -------------------------------------------------------------------------- */

export const EMBEDDING_DIM = 512;

/**
 * Scales an embedding to unit length.
 *
 * ArcFace is trained with an angular margin, so only the direction of the
 * vector carries identity; its length carries image quality and nothing else.
 * Normalising is what makes a single threshold mean the same thing for a bright
 * close-up and a dim distant face.
 */
export function l2normalise(v: Float32Array | number[]): number[] {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  const norm = Math.sqrt(sum) || 1;
  const out = new Array<number>(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
}

/** Cosine similarity between two unit vectors: 1 is the same face, 0 unrelated. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

/**
 * Cosine distance, which is what the rest of the app compares against a
 * threshold. Zero is identical, one is unrelated, two is opposite.
 */
export function cosineDistance(a: readonly number[], b: readonly number[]): number {
  return 1 - cosine(a, b);
}
