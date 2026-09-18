import assert from "node:assert/strict";
import { unzipSync } from "fflate";
import { handleApiRequest } from "../src/lib/api.server.ts";
import { createSessionToken, SESSION_COOKIE } from "../src/lib/auth/session.ts";
import { downloadPhotos, safeFileName, type Directory } from "../src/lib/photo-download.ts";
import type { MediaEnv } from "../src/lib/media.server.ts";

const cid = crypto.randomUUID(), admin = crypto.randomUUID(), member = crypto.randomUUID();
const pid = crypto.randomUUID(), missing = crypto.randomUUID();
const reference = Array.from({ length: 512 }, (_, index) => index === 0 ? 1 : 0);
const records = new Map<string, unknown>([
  [`meta/member/${admin}`, { id: admin, role: "admin", references: [] }],
  [`meta/member/${member}`, { id: member, role: "member", references: [reference] }],
  [`meta/collection/${cid}`, { id: cid, name: "Test event" }],
  [`meta/photo/${cid}/${pid}`, { id: pid, fileName: "photo.jpg", width: 800, height: 600 }],
]);
let writes = 0;
const env = {
  SESSION_SECRET: "local-test-secret-only",
  PHOTOS: {
    get: async (key: string) => records.has(key) ? { json: async () => records.get(key) } : null,
    head: async (key: string) => records.has(key) ? {} : null,
    put: async () => { writes++; }, delete: async () => { writes++; },
  },
  FACE_INDEX: {
    query: async (_values: number[], options: { namespace: string }) => {
      assert.ok(options.namespace.startsWith(cid + "#"));
      return { matches: [{ id: pid + ":0", score: 1 }, { id: missing + ":0", score: 1 }] };
    },
    getByIds: async () => [], upsert: async () => {}, deleteByIds: async () => {},
  },
} as unknown as MediaEnv;
const token = await createSessionToken(admin, env.SESSION_SECRET!);
const memberToken = await createSessionToken(member, env.SESSION_SECRET!);
async function search(body: unknown, auth: string | null = token, environment = env) {
  return (await handleApiRequest(new Request("https://local.test/api/admin/photo-search", {
    method: "POST", headers: { "content-type": "application/json", ...(auth ? { cookie: `${SESSION_COOKIE}=${auth}` } : {}) },
    body: JSON.stringify(body),
  }), environment))!;
}
assert.equal((await search({ collectionId: cid, userId: member }, null)).status, 401);
assert.equal((await search({ collectionId: cid, userId: member }, memberToken)).status, 403);
assert.equal((await search({ collectionId: "../private", userId: member })).status, 400);
assert.equal((await search({ collectionId: crypto.randomUUID(), userId: member })).status, 404);
assert.equal((await search({ collectionId: cid, userId: admin })).status, 400);
assert.equal((await search({ collectionId: cid, references: [[1]] })).status, 400);
assert.equal((await search({ collectionId: cid, references: [Array(512).fill(0)] })).status, 400);
assert.equal((await search({ collectionId: cid, references: [reference], userId: member })).status, 400);
assert.equal((await search(null)).status, 400);
const { FACE_INDEX: _index, ...offline } = env;
assert.equal((await search({ collectionId: cid, userId: member }, token, offline)).status, 503);
for (const source of [{ userId: member }, { references: [reference] }]) {
  const response = await search({ collectionId: cid, ...source });
  assert.equal(response.status, 200);
  const result = await response.json() as { hits: { photoId: string }[] };
  assert.deepEqual(result.hits.map((hit) => hit.photoId), [pid]);
}
assert.equal(writes, 0, "Admin searches must not write profiles, scans or waiting rows");

const bytes = new Uint8Array([255, 216, 255, 1, 2, 3]);
const files = new Map<string, Uint8Array>();
const directory: Directory = {
  getDirectoryHandle: async () => directory,
  getFileHandle: async (name) => ({
    createWritable: async () => new WritableStream({ write(chunk) { files.set(name, chunk); } }),
  }),
  removeEntry: async (name) => { files.delete(name); },
};
const photos = [
  { photoId: pid, fileName: "../photo.jpg", fullUrl: `/media/p/${cid}/${pid}` },
  { photoId: missing, fileName: "../photo.jpg", fullUrl: `/media/p/${cid}/${missing}` },
];
const fetcher: typeof fetch = async () => new Response(bytes, { headers: { "content-type": "image/jpeg" } });
const signal = new AbortController().signal;
const saved = await downloadPhotos([...photos, photos[0]!], directory, "../Person/Event", signal, () => {}, fetcher);
assert.equal(saved.saved, 2);
assert.equal(files.size, 2);
assert.ok([...files.keys()].every((key) => !key.includes("/") && !key.includes("\\")));
const zipped = await downloadPhotos(photos, null, "Person", signal, () => {}, fetcher);
const unpacked = unzipSync(new Uint8Array(await zipped.blob!.arrayBuffer()));
assert.equal(Object.keys(unpacked).length, 2);
for (const value of Object.values(unpacked)) assert.deepEqual(value, bytes);
const failedFetch: typeof fetch = async () => new Response("missing", { status: 404 });
assert.equal((await downloadPhotos(photos, directory, "Person", signal, () => {}, failedFetch)).failed.length, 2);
await assert.rejects(downloadPhotos(photos, null, "Person", signal, () => {}, failedFetch));
const cancelled = new AbortController(); cancelled.abort();
await assert.rejects(downloadPhotos(photos, directory, "Person", cancelled.signal, () => {}, fetcher));
assert.equal((await downloadPhotos([], directory, "Person", signal, () => {}, fetcher)).saved, 0);
assert.equal(safeFileName("../../bad:name?"), "_.._bad_name_");
console.log("Admin export: authorization, input validation, saved/custom references, deleted photos, no writes, folders, ZIP integrity, deduplication, failed files and cancellation passed.");
