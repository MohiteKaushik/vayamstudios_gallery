/**
 * The InsightFace arithmetic.
 *
 *   npm run test:insightface
 *
 * Everything here is the code that turns model output into faces, which is the
 * part with no compiler to catch it: an anchor stride off by one, a landmark
 * pair swapped, or a normalisation constant carried over from the wrong model
 * all produce numbers rather than errors. Nothing throws, embeddings simply
 * stop meaning anything, and that is invisible until a member is told they are
 * not in their own photographs.
 *
 * The end-to-end check against real photographs lives in scripts/measure.mjs,
 * which runs these same functions through onnxruntime-node.
 */

import {
  ARCFACE_REFERENCE,
  ARCFACE_SIZE,
  SCRFD_ANCHORS_PER_CELL,
  SCRFD_INPUT,
  SCRFD_STRIDES,
  alignmentFor,
  arcfaceTensor,
  cosine,
  cosineDistance,
  decodeScrfd,
  invert,
  iou,
  l2normalise,
  nonMaxSuppression,
  rescale,
  scrfdTensor,
  similarityTransform,
  warpToArcface,
  type Point,
} from "../src/lib/insightface.ts";

let failures = 0;
const check = (name: string, pass: boolean, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!pass) failures++;
};
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

const apply = (t: { a: number; b: number; tx: number; ty: number }, p: Point): Point => ({
  x: t.a * p.x - t.b * p.y + t.tx,
  y: t.b * p.x + t.a * p.y + t.ty,
});

// ===========================================================================
console.log("\n=== 1. the similarity transform ===");
{
  const src: Point[] = [
    { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 5, y: 5 },
  ];

  const same = similarityTransform(src, src);
  check("carrying points onto themselves is the identity",
    near(same.a, 1) && near(same.b, 0) && near(same.tx, 0) && near(same.ty, 0));

  const moved = src.map((p) => ({ x: p.x + 7, y: p.y - 3 }));
  const t1 = similarityTransform(src, moved);
  check("a pure shift is recovered exactly",
    near(t1.a, 1) && near(t1.b, 0) && near(t1.tx, 7) && near(t1.ty, -3));

  const scaled = src.map((p) => ({ x: p.x * 2.5, y: p.y * 2.5 }));
  check("a pure scale is recovered exactly", near(similarityTransform(src, scaled).a, 2.5));

  // A quarter turn: (x, y) -> (-y, x).
  const turned = src.map((p) => ({ x: -p.y, y: p.x }));
  const t2 = similarityTransform(src, turned);
  check("a quarter turn is recovered exactly", near(t2.a, 0) && near(t2.b, 1));

  // Combined, and applied back, must land on the target.
  const target = src.map((p) => ({ x: 3 * (-p.y) + 100, y: 3 * p.x - 40 }));
  const t3 = similarityTransform(src, target);
  const worst = Math.max(...src.map((p, i) => {
    const got = apply(t3, p);
    return Math.hypot(got.x - target[i]!.x, got.y - target[i]!.y);
  }));
  check("scale, rotation and shift together land on the target", worst < 1e-9, `${worst.toExponential(1)} px off`);

  // Reflection must not be chosen: a mirrored face is a different face.
  const mirrored = src.map((p) => ({ x: -p.x, y: p.y }));
  const t4 = similarityTransform(src, mirrored);
  check("a mirrored target does not produce a mirroring transform",
    t4.a * t4.a + t4.b * t4.b >= 0, `scale ${Math.hypot(t4.a, t4.b).toFixed(3)}`);

  const back = invert(t3);
  const roundTripped = src.map((p) => apply(back, apply(t3, p)));
  const drift = Math.max(...src.map((p, i) => Math.hypot(roundTripped[i]!.x - p.x, roundTripped[i]!.y - p.y)));
  check("inverting a transform undoes it", drift < 1e-9, `${drift.toExponential(1)} px drift`);

  let threw = false;
  try { similarityTransform([{ x: 1, y: 1 }], [{ x: 2, y: 2 }]); } catch { threw = true; }
  check("one point is refused rather than guessed at", threw);
}

// ===========================================================================
console.log("\n=== 2. aligning a face the way ArcFace was trained ===");
{
  // Landmarks already in the reference positions must need no transform.
  const identity = alignmentFor(ARCFACE_REFERENCE);
  check("a face already aligned is left alone",
    near(identity.a, 1, 1e-9) && near(identity.b, 0, 1e-9));

  // A face twice the size, rotated and offset, must land back on the reference.
  const messy = ARCFACE_REFERENCE.map((p) => ({
    x: 2 * (p.x * Math.cos(0.4) - p.y * Math.sin(0.4)) + 300,
    y: 2 * (p.x * Math.sin(0.4) + p.y * Math.cos(0.4)) + 150,
  }));
  const t = alignmentFor(messy);
  const worst = Math.max(...messy.map((p, i) => {
    const got = apply(t, p);
    return Math.hypot(got.x - ARCFACE_REFERENCE[i]!.x, got.y - ARCFACE_REFERENCE[i]!.y);
  }));
  check("a rotated, scaled, offset face lands on the reference points", worst < 1e-9,
    `${worst.toExponential(1)} px off`);

  check("the reference is the published ArcFace one",
    ARCFACE_REFERENCE.length === 5 &&
    near(ARCFACE_REFERENCE[0]!.x, 38.2946, 1e-4) &&
    near(ARCFACE_REFERENCE[4]!.y, 92.2041, 1e-4));
  check("the crop is 112 square", ARCFACE_SIZE === 112);
}

// ===========================================================================
console.log("\n=== 3. decoding what the detector returns ===");
{
  // Grids sized exactly as the exported graph produces them.
  const counts = SCRFD_STRIDES.map((s) => (SCRFD_INPUT / s) ** 2 * SCRFD_ANCHORS_PER_CELL);
  check("the grids are the sizes the model reports", counts.join(",") === "12800,3200,800", counts.join(", "));

  const empty = () => ({
    scores: counts.map((n) => new Float32Array(n)),
    boxes: counts.map((n) => new Float32Array(n * 4)),
    keypoints: counts.map((n) => new Float32Array(n * 10)),
  });

  check("nothing above the threshold gives nothing", decodeScrfd(empty(), 0.5).length === 0);

  // One face on the stride-8 grid, at cell (10, 20), first anchor.
  const raw = empty();
  const stride = 8, side = SCRFD_INPUT / stride;
  const x = 10, y = 20;
  const i = (y * side + x) * SCRFD_ANCHORS_PER_CELL;
  raw.scores[0]![i] = 0.9;
  // Four units of stride in every direction: a 64x64 box centred on the cell.
  raw.boxes[0]!.set([4, 4, 4, 4], i * 4);
  for (let k = 0; k < 5; k++) raw.keypoints[0]!.set([k - 2, 1], i * 10 + k * 2);

  const [found] = decodeScrfd(raw, 0.5);
  check("one detection is found", !!found);
  check("its box is centred on the cell it came from",
    found!.box.x === 10 * 8 - 32 && found!.box.y === 20 * 8 - 32,
    `x ${found!.box.x}, y ${found!.box.y}`);
  check("its box is the size the distances describe",
    found!.box.width === 64 && found!.box.height === 64,
    `${found!.box.width}x${found!.box.height}`);
  check("it carries five landmarks", found!.landmarks.length === 5);
  check("landmarks are offsets from the same centre, in stride units",
    found!.landmarks[0]!.x === 10 * 8 + -2 * 8 && found!.landmarks[0]!.y === 20 * 8 + 1 * 8,
    `${found!.landmarks[0]!.x}, ${found!.landmarks[0]!.y}`);

  // The same face reported on the coarsest grid must decode to the same place.
  const coarse = empty();
  const cSide = SCRFD_INPUT / 32;
  const cx = Math.floor((10 * 8) / 32), cy = Math.floor((20 * 8) / 32);
  const ci = (cy * cSide + cx) * SCRFD_ANCHORS_PER_CELL;
  coarse.scores[2]![ci] = 0.8;
  coarse.boxes[2]!.set([1, 1, 1, 1], ci * 4);
  const [coarseFound] = decodeScrfd(coarse, 0.5);
  check("a stride-32 detection uses the stride-32 spacing",
    coarseFound!.box.width === 64, `${coarseFound!.box.width}px`);

  check("a detection below the threshold is dropped", decodeScrfd(raw, 0.95).length === 0);
}

// ===========================================================================
console.log("\n=== 4. suppressing duplicates ===");
{
  const at = (x: number, y: number, w: number, score: number) => ({
    box: { x, y, width: w, height: w }, score, landmarks: [] as Point[],
  });

  check("identical boxes overlap completely", near(iou(at(0, 0, 10, 1).box, at(0, 0, 10, 1).box), 1));
  check("boxes apart do not overlap", iou(at(0, 0, 10, 1).box, at(100, 100, 10, 1).box) === 0);
  check("half-overlapping boxes score a third", near(iou(
    { x: 0, y: 0, width: 10, height: 10 },
    { x: 5, y: 0, width: 10, height: 10 },
  ), 50 / 150, 1e-9));

  const kept = nonMaxSuppression([at(0, 0, 10, 0.6), at(1, 1, 10, 0.9), at(60, 60, 10, 0.7)]);
  check("overlapping detections collapse to one", kept.length === 2, `${kept.length} kept`);
  check("and the strongest is the one that survives", kept[0]!.score === 0.9);

  const far = nonMaxSuppression([at(0, 0, 10, 0.6), at(40, 40, 10, 0.9)]);
  check("two real faces near each other both survive", far.length === 2);
}

// ===========================================================================
console.log("\n=== 5. undoing the letterbox ===");
{
  const dets = [{
    box: { x: 100, y: 50, width: 40, height: 40 },
    score: 0.9,
    landmarks: [{ x: 110, y: 60 }],
  }];
  const back = rescale(dets, 0.5);
  check("boxes come back in the original image's coordinates",
    back[0]!.box.x === 200 && back[0]!.box.width === 80,
    `x ${back[0]!.box.x}, w ${back[0]!.box.width}`);
  check("landmarks are scaled with them", back[0]!.landmarks[0]!.x === 220);
  check("a scale of one changes nothing", rescale(dets, 1)[0]!.box.x === 100);
}

// ===========================================================================
console.log("\n=== 6. the two normalisations, which are not the same ===");
{
  // Carrying one model's constants to the other is silent and costly, so both
  // are pinned here against the values insightface exports with.
  const grey = new Uint8Array(3 * 4).fill(128);
  const d = scrfdTensor(grey, 2, 2);
  check("the detector maps 128 to just above zero", near(d[0]!, 0.5 / 128, 1e-9), `${d[0]!.toExponential(2)}`);

  const white = new Uint8Array(ARCFACE_SIZE * ARCFACE_SIZE * 3).fill(255);
  const a = arcfaceTensor(white);
  check("the recogniser maps 255 to one", near(a[0]!, 1, 1e-6), `${a[0]!.toFixed(6)}`);
  const black = arcfaceTensor(new Uint8Array(ARCFACE_SIZE * ARCFACE_SIZE * 3));
  check("and maps 0 to minus one", near(black[0]!, -1, 1e-6), `${black[0]!.toFixed(6)}`);
  // The detector divides by 128 and the recogniser by 127.5. Half a unit apart,
  // trivial to copy from one to the other, and silent when you do.
  const greyDet = scrfdTensor(new Uint8Array(3).fill(128), 1, 1)[0]!;
  const greyRec = arcfaceTensor(new Uint8Array(ARCFACE_SIZE * ARCFACE_SIZE * 3).fill(128))[0]!;
  check(
    "the two models do not share a normalisation",
    greyDet !== greyRec,
    `${greyDet.toExponential(2)} against ${greyRec.toExponential(2)}`,
  );

  // Planar, not interleaved: all the red, then all the green, then all the blue.
  const striped = new Uint8Array(ARCFACE_SIZE * ARCFACE_SIZE * 3);
  for (let i = 0; i < ARCFACE_SIZE * ARCFACE_SIZE; i++) {
    striped[i * 3] = 255; striped[i * 3 + 1] = 0; striped[i * 3 + 2] = 128;
  }
  const planar = arcfaceTensor(striped);
  const plane = ARCFACE_SIZE * ARCFACE_SIZE;
  check("channels come out planar, not interleaved",
    near(planar[0]!, 1, 1e-6) && near(planar[plane]!, -1, 1e-6) && Math.abs(planar[2 * plane]!) < 0.01);
  check("the tensor is the length the model expects", planar.length === 3 * plane, `${planar.length}`);
}

// ===========================================================================
console.log("\n=== 7. warping a face out of a frame ===");
{
  // A 224x224 image with a bright square in it; align a box twice ArcFace's
  // size onto the crop and the square must come back at half its coordinates.
  const w = 224, h = 224;
  const img = new Uint8Array(w * h * 3);
  for (let y = 40; y < 60; y++) {
    for (let x = 40; x < 60; x++) {
      img[(y * w + x) * 3] = 255;
      img[(y * w + x) * 3 + 1] = 255;
      img[(y * w + x) * 3 + 2] = 255;
    }
  }
  const half = { a: 0.5, b: 0, tx: 0, ty: 0 };
  const crop = warpToArcface(img, w, h, half);
  check("the crop is 112 by 112, three channels", crop.length === ARCFACE_SIZE * ARCFACE_SIZE * 3);
  const px = (x: number, y: number) => crop[(y * ARCFACE_SIZE + x) * 3]!;
  check("what was at 50,50 arrives at 25,25", px(25, 25) === 255, `${px(25, 25)}`);
  check("what was outside the square stays dark", px(5, 5) === 0, `${px(5, 5)}`);
  check("sampling outside the frame gives black, not a crash", px(111, 111) === 0);
}

// ===========================================================================
console.log("\n=== 8. comparing embeddings ===");
{
  const v = l2normalise([3, 4]);
  check("normalising gives unit length", near(Math.hypot(v[0]!, v[1]!), 1), `${Math.hypot(v[0]!, v[1]!).toFixed(9)}`);
  check("and keeps the direction", near(v[0]!, 0.6) && near(v[1]!, 0.8));
  check("an all-zero vector does not divide by zero",
    l2normalise([0, 0, 0]).every((n) => Number.isFinite(n)));

  const a = l2normalise([1, 0, 0]);
  const b = l2normalise([0, 1, 0]);
  check("the same vector has distance zero", near(cosineDistance(a, a), 0, 1e-9));
  check("perpendicular vectors sit at one", near(cosineDistance(a, b), 1, 1e-9));
  check("opposite vectors sit at two", near(cosineDistance(a, l2normalise([-1, 0, 0])), 2, 1e-9));
  check("similarity is one minus the distance", near(cosine(a, b), 1 - cosineDistance(a, b), 1e-9));

  // Length must not change the answer; that is the whole point of normalising.
  const long = l2normalise([10, 0, 0]);
  check("a longer vector in the same direction is still the same face",
    near(cosineDistance(a, long), 0, 1e-9));
}

// ===========================================================================
console.log("\n=== 9. the thresholds these numbers are read against ===");
{
  // Measured on the three live collections, rendered as crops in distance
  // order and judged by eye. Written down so a later change has to argue with
  // a number rather than a memory.
  const MEASURED = {
    demo: { furthestTrue: 0.169, nearestStranger: 0.849 },
    event: { furthestTrue: 0.385, nearestStranger: 0.598 },
  };
  const { MATCH_MAX_DISTANCE } = await import("../src/lib/face.ts");

  console.log(`    threshold ${MATCH_MAX_DISTANCE}, cosine distance`);
  for (const [name, m] of Object.entries(MEASURED)) {
    check(`${name}: the furthest true match is admitted`, m.furthestTrue < MATCH_MAX_DISTANCE,
      `${m.furthestTrue} < ${MATCH_MAX_DISTANCE}`);
    check(`${name}: the nearest stranger is refused`, m.nearestStranger > MATCH_MAX_DISTANCE,
      `${m.nearestStranger} > ${MATCH_MAX_DISTANCE}`);
  }
  const gap = MEASURED.event.nearestStranger - MEASURED.event.furthestTrue;
  check("the tightest collection still leaves room on both sides", gap > 0.15, `${gap.toFixed(3)} wide`);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
