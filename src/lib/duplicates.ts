/**
 * Finding duplicate photographs inside an event.
 *
 * Arithmetic only, like insightface.ts: pixels in, fingerprints and groups out.
 * The browser feeds it from a canvas, and the test and calibration scripts feed
 * it the very same way from sharp, so thresholds measured offline mean the same
 * thing in the console.
 *
 * A FINGERPRINT IS THREE READINGS OF ONE PHOTO
 *
 *   dHash   64 bits. Is each pixel darker than its right-hand neighbour, on a
 *           9x8 greyscale copy. Survives re-encoding and resizing; cheap.
 *   pHash   64 bits. The lowest frequencies of a DCT of a 32x32 greyscale copy,
 *           above or below their median. Survives brightness, contrast and
 *           small crops far better than dHash does.
 *   colour  The average colour of each quarter of the frame. Both hashes are
 *           greyscale, and two different shots of the same stage can have the
 *           same shape of light and dark while being plainly different colours.
 *
 * A pair has to pass all three, plus a matching shape of frame. Any single hash
 * on its own confuses a wide shot of a hall with a different wide shot of the
 * same hall; requiring agreement from readings that fail in different ways is
 * what keeps that from happening.
 *
 * GROUPS FORM AROUND THE BEST COPY, NOT IN CHAINS
 *
 * Linking every matching pair would let A resemble B and B resemble C until A
 * and C, which look nothing alike, share a group and one of them is offered up
 * for deletion. So each group is built around one photo, the largest and then
 * the earliest uploaded, and only photos that match that photo directly join.
 */

export const DHASH_WIDTH = 9;
export const DHASH_HEIGHT = 8;
export const PHASH_SIZE = 32;
export const COLOUR_GRID = 2;

/** 16 hex for dHash, 16 for pHash, 24 for the four quarter colours. */
export const FINGERPRINT_LENGTH = 56;
const FINGERPRINT_SHAPE = /^[0-9a-f]{56}$/;

export type Fingerprint = {
  d: [number, number];
  p: [number, number];
  /** Twelve bytes: red, green, blue for each quarter, row by row. */
  colour: Uint8Array;
};

/** How alike two photos must be, per reading, to be called duplicates. */
export type Level = {
  dHash: number;
  pHash: number;
  colour: number;
  aspect: number;
  /** A second way to pass: a very close pHash forgives a looser dHash. */
  or?: { dHash: number; pHash: number; colour: number };
};

/**
 * Two strictnesses, set against a real 929-photo event by rendering every group
 * and judging it by eye.
 *
 * "exact" is the same photograph uploaded twice, re-saved or resized. Every one
 * of the six groups it found on that event was a true copy, at distances of 0
 * to 6, so its copies arrive pre-selected for removal.
 *
 * "similar" adds near-identical frames, and on that event most of what it found
 * was burst shots of one moment. Not all: a hash reads the shape and colour of a
 * frame, not who is in it, so two different people photographed in front of the
 * same backdrop, one at a time, can sit as close as a burst does. That is why
 * these are shown for the admin to judge and are never selected for them.
 *
 * The `or` rule catches bursts whose edges shifted, a head turned or a hand
 * raised, which dHash reads as a large change while pHash barely moves.
 *
 * Distances are Hamming distances out of 64 and a mean colour difference out
 * of 255.
 */
export const LEVELS: Record<"exact" | "similar", Level> = {
  exact: { dHash: 4, pHash: 6, colour: 10, aspect: 0.02 },
  similar: { dHash: 12, pHash: 16, colour: 24, aspect: 0.03, or: { dHash: 16, pHash: 8, colour: 16 } },
};

/* -------------------------------------------------------------------------- */
/*                                 Reading pixels                             */
/* -------------------------------------------------------------------------- */

type Pixels = Uint8Array | Uint8ClampedArray;

const luma = (px: Pixels, i: number) => 0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]!;

/** From RGBA pixels of a 9x8 copy of the photo. */
export function dHash(rgba: Pixels): [number, number] {
  let lo = 0;
  let hi = 0;
  let bit = 0;
  for (let y = 0; y < DHASH_HEIGHT; y++) {
    for (let x = 0; x < DHASH_WIDTH - 1; x++) {
      const left = luma(rgba, (y * DHASH_WIDTH + x) * 4);
      const right = luma(rgba, (y * DHASH_WIDTH + x + 1) * 4);
      if (left < right) {
        if (bit < 32) lo |= 1 << bit;
        else hi |= 1 << (bit - 32);
      }
      bit++;
    }
  }
  return [hi >>> 0, lo >>> 0];
}

const DCT_KEEP = 8;
const COS = (() => {
  const table = new Float64Array(DCT_KEEP * PHASH_SIZE);
  for (let u = 0; u < DCT_KEEP; u++) {
    for (let x = 0; x < PHASH_SIZE; x++) {
      table[u * PHASH_SIZE + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * PHASH_SIZE));
    }
  }
  return table;
})();

/**
 * From RGBA pixels of a 32x32 copy.
 *
 * Only the lowest 8x8 frequencies are ever needed, so the DCT is done
 * separably and stops there: about ten thousand multiplications a photo rather
 * than the million a full 32x32 transform would cost.
 */
export function pHash(rgba: Pixels): [number, number] {
  const N = PHASH_SIZE;
  const grey = new Float64Array(N * N);
  for (let i = 0; i < N * N; i++) grey[i] = luma(rgba, i * 4);

  const rows = new Float64Array(DCT_KEEP * N);
  for (let u = 0; u < DCT_KEEP; u++) {
    for (let y = 0; y < N; y++) {
      let sum = 0;
      for (let x = 0; x < N; x++) sum += grey[y * N + x]! * COS[u * N + x]!;
      rows[u * N + y] = sum;
    }
  }
  const coeffs = new Float64Array(DCT_KEEP * DCT_KEEP);
  for (let v = 0; v < DCT_KEEP; v++) {
    for (let u = 0; u < DCT_KEEP; u++) {
      let sum = 0;
      for (let y = 0; y < N; y++) sum += rows[u * N + y]! * COS[v * N + y]!;
      coeffs[v * DCT_KEEP + u] = sum;
    }
  }

  // The DC term is the overall brightness, which is exactly what should not
  // matter, so it sits out of the median and its bit is always zero.
  const ac = Array.from(coeffs.slice(1)).sort((a, b) => a - b);
  const median = (ac[31]! + ac[32]!) / 2;

  let lo = 0;
  let hi = 0;
  for (let bit = 1; bit < 64; bit++) {
    if (coeffs[bit]! > median) {
      if (bit < 32) lo |= 1 << bit;
      else hi |= 1 << (bit - 32);
    }
  }
  return [hi >>> 0, lo >>> 0];
}

/** From RGBA pixels of a 2x2 copy: the average colour of each quarter. */
export function colourSignature(rgba: Pixels): Uint8Array {
  const out = new Uint8Array(COLOUR_GRID * COLOUR_GRID * 3);
  for (let i = 0; i < COLOUR_GRID * COLOUR_GRID; i++) {
    out[i * 3] = rgba[i * 4]!;
    out[i * 3 + 1] = rgba[i * 4 + 1]!;
    out[i * 3 + 2] = rgba[i * 4 + 2]!;
  }
  return out;
}

/**
 * The one resize done outside this file: every photo is first scaled to 64x64
 * by whatever reads it, a canvas in the browser and sharp in the scripts.
 *
 * Every smaller grid is made from that here, by plain averaging. Asking a
 * browser to shrink a 512 pixel thumbnail straight to 2x2 samples a handful of
 * pixels and gives a different answer in each browser; one shared large step
 * and identical arithmetic after it gives the same fingerprint everywhere.
 */
export const SOURCE_SIZE = 64;

function boxDownsample(rgba: Pixels, width: number, height: number): Uint8Array {
  const sums = new Float64Array(width * height * 3);
  const counts = new Uint32Array(width * height);
  for (let y = 0; y < SOURCE_SIZE; y++) {
    const by = Math.floor((y * height) / SOURCE_SIZE);
    for (let x = 0; x < SOURCE_SIZE; x++) {
      const bx = Math.floor((x * width) / SOURCE_SIZE);
      const cell = by * width + bx;
      const src = (y * SOURCE_SIZE + x) * 4;
      sums[cell * 3] = sums[cell * 3]! + rgba[src]!;
      sums[cell * 3 + 1] = sums[cell * 3 + 1]! + rgba[src + 1]!;
      sums[cell * 3 + 2] = sums[cell * 3 + 2]! + rgba[src + 2]!;
      counts[cell]!++;
    }
  }
  const out = new Uint8Array(width * height * 4);
  for (let cell = 0; cell < width * height; cell++) {
    const n = counts[cell]! || 1;
    out[cell * 4] = Math.round(sums[cell * 3]! / n);
    out[cell * 4 + 1] = Math.round(sums[cell * 3 + 1]! / n);
    out[cell * 4 + 2] = Math.round(sums[cell * 3 + 2]! / n);
    out[cell * 4 + 3] = 255;
  }
  return out;
}

/** A photo's fingerprint, from RGBA pixels of a 64x64 copy of it. */
export function fingerprintPixels(rgba64: Pixels): string {
  return encodeFingerprint({
    d: dHash(boxDownsample(rgba64, DHASH_WIDTH, DHASH_HEIGHT)),
    p: pHash(boxDownsample(rgba64, PHASH_SIZE, PHASH_SIZE)),
    colour: colourSignature(boxDownsample(rgba64, COLOUR_GRID, COLOUR_GRID)),
  });
}

/* -------------------------------------------------------------------------- */
/*                               Storing and comparing                        */
/* -------------------------------------------------------------------------- */

const hex32 = (n: number) => (n >>> 0).toString(16).padStart(8, "0");

export function encodeFingerprint(fp: Fingerprint): string {
  let colour = "";
  for (const b of fp.colour) colour += b.toString(16).padStart(2, "0");
  return hex32(fp.d[0]) + hex32(fp.d[1]) + hex32(fp.p[0]) + hex32(fp.p[1]) + colour;
}

export function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && FINGERPRINT_SHAPE.test(value);
}

export function decodeFingerprint(value: string): Fingerprint | null {
  if (!isFingerprint(value)) return null;
  const n = (from: number) => parseInt(value.slice(from, from + 8), 16) >>> 0;
  const colour = new Uint8Array(12);
  for (let i = 0; i < 12; i++) colour[i] = parseInt(value.slice(32 + i * 2, 34 + i * 2), 16);
  return { d: [n(0), n(8)], p: [n(16), n(24)], colour };
}

function popcount(n: number): number {
  n = n - ((n >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export const hamming = (a: [number, number], b: [number, number]) =>
  popcount((a[0] ^ b[0]) >>> 0) + popcount((a[1] ^ b[1]) >>> 0);

/** Mean absolute difference across the twelve colour channels, 0 to 255. */
export function colourDistance(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length;
}

export type Comparison = { dHash: number; pHash: number; colour: number; aspect: number };

export function compare(
  a: { fp: Fingerprint; width: number; height: number },
  b: { fp: Fingerprint; width: number; height: number },
): Comparison {
  const ra = a.width && a.height ? a.width / a.height : 1;
  const rb = b.width && b.height ? b.width / b.height : 1;
  return {
    dHash: hamming(a.fp.d, b.fp.d),
    pHash: hamming(a.fp.p, b.fp.p),
    colour: colourDistance(a.fp.colour, b.fp.colour),
    aspect: Math.abs(ra - rb) / Math.max(ra, rb),
  };
}

export const passes = (c: Comparison, level: Level) =>
  c.aspect <= level.aspect &&
  ((c.dHash <= level.dHash && c.pHash <= level.pHash && c.colour <= level.colour) ||
    (!!level.or && c.dHash <= level.or.dHash && c.pHash <= level.or.pHash && c.colour <= level.or.colour));

/* -------------------------------------------------------------------------- */
/*                                    Grouping                                */
/* -------------------------------------------------------------------------- */

export type DuplicateCandidate = {
  id: string;
  width: number;
  height: number;
  createdAt: number;
  fingerprint: string;
};

export type DuplicateGroup = {
  /** The copy to keep: the largest, then the earliest uploaded. */
  keep: string;
  /** The others, each with how close it is to the one kept. */
  copies: { id: string; comparison: Comparison; exact: boolean }[];
};

/**
 * Groups duplicates around the best copy of each.
 *
 * Every photo is compared with every other, which is about half a million
 * comparisons for a thousand-photo event and takes a few milliseconds; the
 * comparisons are integer bit counts, not pixels.
 */
export function findDuplicateGroups(items: DuplicateCandidate[], level: Level): DuplicateGroup[] {
  const decoded = items
    .map((item) => ({ ...item, fp: decodeFingerprint(item.fingerprint) }))
    .filter((item): item is DuplicateCandidate & { fp: Fingerprint } => item.fp !== null)
    .sort((a, b) => b.width * b.height - a.width * a.height || a.createdAt - b.createdAt);

  const taken = new Set<string>();
  const groups: DuplicateGroup[] = [];

  for (let i = 0; i < decoded.length; i++) {
    const keep = decoded[i]!;
    if (taken.has(keep.id)) continue;

    const copies: DuplicateGroup["copies"] = [];
    for (let j = i + 1; j < decoded.length; j++) {
      const other = decoded[j]!;
      if (taken.has(other.id)) continue;
      const comparison = compare(keep, other);
      if (passes(comparison, level)) {
        copies.push({ id: other.id, comparison, exact: passes(comparison, LEVELS.exact) });
      }
    }

    if (copies.length > 0) {
      taken.add(keep.id);
      for (const c of copies) taken.add(c.id);
      groups.push({ keep: keep.id, copies });
    }
  }

  // Groups with the most copies first: that is where the clutter is.
  return groups.sort((a, b) => b.copies.length - a.copies.length);
}
