/**
 * Measures the InsightFace pipeline against the real collections, offline.
 *
 * Runs the exact functions src/lib/insightface.ts gives the browser, through
 * onnxruntime-node and sharp instead of onnxruntime-web and a canvas, so a
 * number measured here means something about what a member gets.
 */
import fs from "node:fs";
import path from "node:path";
import ort from "onnxruntime-node";
import sharp from "sharp";
import {
  decodeScrfd, nonMaxSuppression, rescale, scrfdTensor, arcfaceTensor,
  warpToArcface, alignmentFor, l2normalise, cosineDistance,
  SCRFD_INPUT, ARCFACE_SIZE,
} from "./src/lib/insightface.ts";

const SP = process.env.SP;
const R2 = "https://pub-c3d241c9618b4d51a2a52d43f94f7a7d.r2.dev";
const DET_THRESHOLD = 0.5;

const det = await ort.InferenceSession.create("public/models/scrfd-500m.onnx");
const rec = await ort.InferenceSession.create("public/models/arcface-w600k-mbf.onnx");
const detOut = det.outputNames;

/** Letterboxes an image into the 640x640 the detector wants. */
async function prepare(buffer) {
  const img = sharp(buffer, { failOn: "none" }).rotate();
  const meta = await img.metadata();
  const scale = Math.min(SCRFD_INPUT / meta.width, SCRFD_INPUT / meta.height);
  const w = Math.max(1, Math.round(meta.width * scale));
  const h = Math.max(1, Math.round(meta.height * scale));
  const resized = await img.resize(w, h, { fit: "fill" }).removeAlpha().raw().toBuffer();
  const full = await sharp(buffer, { failOn: "none" }).rotate().removeAlpha().raw().toBuffer();
  return { resized: new Uint8Array(resized), w, h, scale, full: new Uint8Array(full), fw: meta.width, fh: meta.height };
}

async function facesIn(buffer) {
  const p = await prepare(buffer);
  const input = new ort.Tensor("float32", scrfdTensor(p.resized, p.w, p.h), [1, 3, SCRFD_INPUT, SCRFD_INPUT]);
  const out = await det.run({ "input.1": input });

  const raw = {
    scores: [out[detOut[0]].data, out[detOut[1]].data, out[detOut[2]].data],
    boxes: [out[detOut[3]].data, out[detOut[4]].data, out[detOut[5]].data],
    keypoints: [out[detOut[6]].data, out[detOut[7]].data, out[detOut[8]].data],
  };
  const dets = rescale(nonMaxSuppression(decodeScrfd(raw, DET_THRESHOLD)), p.scale);

  const faces = [];
  for (const d of dets) {
    const crop = warpToArcface(p.full, p.fw, p.fh, alignmentFor(d.landmarks));
    const t = new ort.Tensor("float32", arcfaceTensor(crop), [1, 3, ARCFACE_SIZE, ARCFACE_SIZE]);
    const e = await rec.run({ "input.1": t });
    faces.push({
      box: d.box, score: d.score, landmarks: d.landmarks,
      embedding: l2normalise(e[rec.outputNames[0]].data),
      crop,
    });
  }
  return faces;
}

/* ------------------------------------------------------------------ */

const old = JSON.parse(fs.readFileSync(`${SP}/faces.json`, "utf8"));
const results = {};

for (const [name, col] of Object.entries(old)) {
  if (!col.faces?.length) continue;
  const photoIds = [...new Set(col.faces.map((f) => f.photoId))];
  process.stdout.write(`\n${name}: ${photoIds.length} photos `);

  const faces = [];
  for (const pid of photoIds) {
    try {
      const buf = Buffer.from(await (await fetch(`${R2}/photo/${col.id}/${pid}`)).arrayBuffer());
      for (const f of await facesIn(buf)) faces.push({ ...f, photoId: pid });
      process.stdout.write(".");
    } catch (e) {
      process.stdout.write("x");
    }
  }
  results[name] = { id: col.id, faces };
  console.log(` ${faces.length} faces (face-api found ${col.faces.length})`);
}

/* ------------------------- what the numbers say ------------------------- */

console.log("\n\nPAIRWISE COSINE DISTANCE BETWEEN EVERY TWO FACES IN A COLLECTION");
console.log("(face-api, for the same collections, measured a median of 0.66 and a first stranger at 0.349)\n");
console.log("collection      faces   min    p05    p25   median   p75    max");
for (const [name, col] of Object.entries(results)) {
  const f = col.faces;
  if (f.length < 2) continue;
  const ds = [];
  for (let i = 0; i < f.length; i++)
    for (let j = i + 1; j < f.length; j++) ds.push(cosineDistance(f[i].embedding, f[j].embedding));
  ds.sort((a, b) => a - b);
  const q = (p) => ds[Math.floor(ds.length * p)].toFixed(3);
  console.log(
    name.padEnd(15) + String(f.length).padStart(5) +
    q(0).padStart(7) + q(0.05).padStart(7) + q(0.25).padStart(7) +
    q(0.5).padStart(8) + q(0.75).padStart(7) + ds[ds.length - 1].toFixed(3).padStart(7));
}

console.log("\n\nHOW MANY OTHERS EACH FACE PULLS IN, AT A RANGE OF THRESHOLDS\n");
console.log("collection      threshold   finds nothing        most any finds   average");
for (const [name, col] of Object.entries(results)) {
  const f = col.faces;
  if (f.length < 2) continue;
  for (const t of [0.3, 0.4, 0.5, 0.6]) {
    const counts = f.map((a) => f.filter((b) => b !== a && cosineDistance(a.embedding, b.embedding) <= t).length);
    console.log(
      name.padEnd(15) + t.toFixed(2).padStart(8) +
      `${String(counts.filter((c) => c === 0).length).padStart(13)} of ${f.length}` +
      String(Math.max(...counts)).padStart(16) +
      (counts.reduce((a, b) => a + b, 0) / f.length).toFixed(1).padStart(10));
  }
}

/* ---------------- contact sheets, for judging identity by eye ------------- */

const CELL = 150, PAD = 22, COLS = 6;
for (const [name, col] of Object.entries(results)) {
  const f = col.faces;
  if (f.length < 4) continue;
  let best = null;
  for (const a of f) {
    const n = f.filter((b) => b !== a && cosineDistance(a.embedding, b.embedding) <= 0.5).length;
    if (!best || n > best.n) best = { a, n };
  }
  const scored = f.filter((b) => b !== best.a)
    .map((b) => ({ b, d: cosineDistance(best.a.embedding, b.embedding) }))
    .sort((p, q) => p.d - q.d).slice(0, 23);

  const cells = [{ label: "REFERENCE", face: best.a }, ...scored.map((s) => ({ label: s.d.toFixed(3), face: s.b }))];
  const rows = Math.ceil(cells.length / COLS);
  const layers = [];
  for (let i = 0; i < cells.length; i++) {
    const x = (i % COLS) * CELL, y = Math.floor(i / COLS) * (CELL + PAD);
    const png = await sharp(Buffer.from(cells[i].face.crop), {
      raw: { width: ARCFACE_SIZE, height: ARCFACE_SIZE, channels: 3 },
    }).resize(CELL, CELL).png().toBuffer();
    layers.push({ input: png, left: x, top: y });
    const isRef = cells[i].label === "REFERENCE";
    const c = isRef ? "#0b5" : Number(cells[i].label) <= 0.5 ? "#c00" : "#777";
    layers.push({
      input: Buffer.from(`<svg width="${CELL}" height="${PAD}"><rect width="${CELL}" height="${PAD}" fill="#fff"/><text x="4" y="16" font-family="monospace" font-size="14" fill="${c}">${cells[i].label}</text></svg>`),
      left: x, top: y + CELL,
    });
  }
  const file = path.join(SP, `arc-${name.replace(/\W/g, "")}.png`);
  await sharp({ create: { width: COLS * CELL, height: rows * (CELL + PAD), channels: 3, background: "#fff" } })
    .composite(layers).png().toFile(file);
  console.log(`\nwrote ${path.basename(file)} — the worst reference and its ${scored.length} nearest, red is within 0.5`);
}

fs.writeFileSync(`${SP}/arcfaces.json`, JSON.stringify(
  Object.fromEntries(Object.entries(results).map(([k, v]) => [k, {
    id: v.id,
    faces: v.faces.map((f) => ({ photoId: f.photoId, box: f.box, score: f.score, embedding: f.embedding })),
  }]))));
console.log("\nembeddings saved to arcfaces.json");
