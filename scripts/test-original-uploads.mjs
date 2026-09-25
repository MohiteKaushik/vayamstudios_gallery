import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { randomBytes, createHash } from "node:crypto";
import ts from "typescript";
import { unzipSync } from "fflate";
import { handleMediaRequest, photoKey, photoMetaKey, thumbKey } from "../src/lib/media.server.ts";
import { createSessionToken, SESSION_COOKIE } from "../src/lib/auth/session.ts";
import { downloadPhotos } from "../src/lib/photo-download.ts";

const cid = crypto.randomUUID(), admin = crypto.randomUUID();
const secret = "original-upload-test-only";
const cookie = `${SESSION_COOKIE}=${await createSessionToken(admin, secret)}`;
const objects = new Map();
objects.set(`meta/member/${admin}`, { bytes: Buffer.from(JSON.stringify({ id: admin, role: "admin" })) });
const env = {
  SESSION_SECRET: secret,
  PHOTOS: {
    async get(key) {
      const object = objects.get(key);
      return object ? {
        body: object.bytes,
        httpEtag: '"test-etag"',
        json: async () => JSON.parse(Buffer.from(object.bytes).toString()),
        writeHttpMetadata: headers => headers.set("content-type", object.type),
      } : null;
    },
    async put(key, body, options) {
      objects.set(key, { bytes: typeof body === "string" ? Buffer.from(body) : new Uint8Array(body), type: options.httpMetadata.contentType });
    },
  },
};
let width = 6000, height = 4000, indexed;
const thumbnail = new Blob(["small thumbnail"], { type: "image/webp" });
const dependencies = {
  "./images": {
    fileToImage: async () => ({ naturalWidth: width, naturalHeight: height }),
    downscale: (_img, edge) => {
      assert.equal(edge, 512, "Only the thumbnail may be downscaled");
      return { canvas: { width: Math.round(width * Math.min(1, edge / Math.max(width, height))), thumbnail: true } };
    },
  },
  "./encode": { encodeImage: async canvas => {
    assert.equal(canvas.thumbnail, true, "Never encode the original");
    return { blob: thumbnail };
  } },
  "./face": { detectFacesThorough: async () => ({ canvas: { width: 1000 }, faces: [
    { descriptor: [1], score: 1, box: { x: 10, y: 20, width: 30, height: 40 } },
  ] }) },
  "./api": { api: { allPhotos: async () => [{ id: currentPhoto, fileName: "photo.jpg" }] } },
};
let currentPhoto;
const storedFiles = [];
async function fetcher(url, init = {}) {
  if (url === "/media/index") {
    indexed = JSON.parse(init.body);
    return Response.json({ indexed: 1 });
  }
  const headers = new Headers(init.headers);
  if (url.startsWith("/media/upload?") && !url.includes("kind=thumb")) storedFiles.push(init.body);
  headers.set("cookie", cookie);
  const response = await handleMediaRequest(new Request(`https://test.local${url}`, { ...init, headers }), env);
  assert.ok(response, `Unexpected URL ${url}`);
  return response;
}
// Mock decoding and face inference only; execute the real uploader, routes and exporter.
function loadClientModule(path) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  runInNewContext(code, {
    exports, require: name => { assert.ok(dependencies[name], name); return dependencies[name]; },
    fetch: fetcher, File, Blob, console, setTimeout,
  });
  return exports;
}
const { uploadPhoto, uploadPhotos } = loadClientModule("../src/lib/upload.ts");
const { reanalyseCollection } = loadClientModule("../src/lib/reanalyse.ts");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
for (const [type, extension, w, h] of [
  ["image/jpeg", "jpg", 6000, 4000], ["image/png", "png", 4000, 6000],
  ["image/webp", "webp", 800, 600], ["image/avif", "avif", 2048, 1365],
]) {
  width = w; height = h;
  const original = randomBytes(2 * 1024 * 1024 + 123);
  const file = new File([original], `original.${extension}`, { type });
  const uploaded = await uploadPhoto({ collectionId: cid, file });
  currentPhoto = uploaded.photoId;
  assert.equal(uploaded.bytesOut, original.length + thumbnail.size);
  assert.equal(hash(objects.get(photoKey(cid, currentPhoto)).bytes), hash(original));
  assert.equal(Buffer.from(objects.get(thumbKey(cid, currentPhoto)).bytes).toString(), await thumbnail.text());
  const meta = JSON.parse(Buffer.from(objects.get(photoMetaKey(cid, currentPhoto)).bytes).toString());
  assert.equal(meta.width, width); assert.equal(meta.height, height);
  assert.equal(meta.contentType, type); assert.equal(meta.fileName, file.name);
  assert.equal(indexed.faces[0].box.x, Math.round(10 * width / 1000));
  const reanalysed = await reanalyseCollection({ collectionId: cid, onProgress() {} });
  assert.equal(reanalysed.failed, 0);
  assert.equal(indexed.faces[0].box.width, Math.round(30 * width / 1000));
  const photos = [{ photoId: currentPhoto, fileName: file.name, fullUrl: `/media/p/${cid}/${currentPhoto}` }];
  const chunks = [];
  const directory = {
    getDirectoryHandle: async () => directory,
    getFileHandle: async () => ({ createWritable: async () => new WritableStream({ write(chunk) { chunks.push(chunk); } }) }),
    removeEntry: async () => {},
  };
  const signal = new AbortController().signal;
  const saved = await downloadPhotos(photos, directory, "Original", signal, () => {}, fetcher);
  assert.equal(saved.saved, 1);
  assert.equal(hash(Buffer.concat(chunks)), hash(original));
  const zipped = await downloadPhotos(photos, null, "Original", signal, () => {}, fetcher);
  const extracted = Object.values(unzipSync(new Uint8Array(await zipped.blob.arrayBuffer())));
  assert.equal(extracted.length, 1);
  assert.equal(hash(extracted[0]), hash(original));
}
const before = objects.size;
await assert.rejects(uploadPhoto({ collectionId: cid, file: new File(["raw"], "photo.heic", { type: "image/heic" }) }), /not converted/);
await assert.rejects(uploadPhoto({ collectionId: cid, file: new File([new Uint8Array(25 * 1024 * 1024 + 1)], "large.jpg", { type: "image/jpeg" }) }), /25 MB/);
assert.equal(objects.size, before, "Rejected files must not create uploads");
const originals = [0, 1, 2].map((i) => new File([randomBytes(64)], `queue-${i}.jpg`, { type: "image/jpeg" }));
const edited = new File([randomBytes(128)], originals[0].name, { type: "image/jpeg" });
storedFiles.length = 0;
let prepared = 0;
const progress = await uploadPhotos({
  collectionId: cid, files: originals, onProgress() {},
  prepareFile: async (file) => {
    assert.equal(storedFiles.length, prepared, "Finish each upload before preparing the next image");
    prepared += 1;
    if (file === originals[2]) throw new Error("Edited file exceeds the size limit");
    return file === originals[0] ? edited : file;
  },
});
assert.equal(progress.processed, 3);
assert.equal(progress.failed, 1);
assert.match(progress.firstError, /size limit/);
assert.equal(storedFiles[0], edited, "Upload the edited copy when edits were requested");
assert.equal(storedFiles[1], originals[1], "An untouched selection stays byte-for-byte original");
assert.equal(storedFiles.length, 2, "Failed edits must not silently upload the original");
console.log("Optional editing: sequential preparation, edited copies, untouched originals, and failure isolation passed.");
console.log("Original uploads: JPEG/PNG/WebP/AVIF unchanged through upload, storage, folder and ZIP; thumbnails separate; original and legacy indexing dimensions; unsupported/oversized files rejected. Passed.");
