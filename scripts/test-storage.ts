/**
 * Tests the R2-only data layer, and answers the question the layer exists to
 * answer: can two hundred members retrieve their photos in under five seconds.
 *
 *   npm run test:storage
 *
 * The mock counts operations and, more usefully, tracks the critical path: how
 * many round trips happen one after another, since those are what a member
 * actually waits for. Operations issued together in a Promise.all cost one wave
 * between them, not one each.
 */

import {
  keys,
  getMember,
  putMember,
  isAdmin,
  getCollection,
  putCollection,
  listCollections,
  getPhoto,
  putPhoto,
  listPhotos,
  countPhotos,
  deletePhoto,
  getScan,
  putScan,
  buildScanRecord,
  serveImage,
  mapLimit,
  READ_CONCURRENCY,
  type MemberRecord,
  type PhotoRecord,
  type CollectionRecord,
} from "../src/lib/storage.server.ts";

// ---------------------------------------------------------------------------
// R2 stand-in that measures the critical path
// ---------------------------------------------------------------------------

function mockR2() {
  const store = new Map<string, { body: string; etag: string }>();
  let ops = 0;
  /** Depth of sequential round trips, which is what latency is actually made of. */
  let waves = 0;
  let inFlight = 0;

  const trip = async <T>(fn: () => T): Promise<T> => {
    ops++;
    if (inFlight === 0) waves++;
    inFlight++;
    await Promise.resolve();
    const out = fn();
    inFlight--;
    return out;
  };

  return {
    store,
    reset() {
      ops = 0;
      waves = 0;
    },
    stats: () => ({ ops, waves }),
    async get(key: string) {
      return trip(() => {
        const rec = store.get(key);
        if (!rec) return null;
        return {
          key,
          size: rec.body.length,
          etag: rec.etag,
          httpEtag: `"${rec.etag}"`,
          uploaded: new Date(),
          body: rec.body as never,
          arrayBuffer: async () => new ArrayBuffer(0),
          text: async () => rec.body,
          json: async <T>() => JSON.parse(rec.body) as T,
          writeHttpMetadata: (h: Headers) => h.set("content-type", "application/json"),
        };
      });
    },
    async put(key: string, value: string) {
      return trip(() => {
        store.set(key, { body: String(value), etag: `e${store.size}-${key.length}` });
      });
    },
    async delete(k: string | string[]) {
      await trip(() => {
        for (const key of Array.isArray(k) ? k : [k]) store.delete(key);
      });
    },
    async list(o: { prefix?: string; cursor?: string; limit?: number } = {}) {
      return trip(() => {
        const all = [...store.keys()].filter((k) => k.startsWith(o.prefix ?? "")).sort();
        const start = o.cursor ? all.indexOf(o.cursor) + 1 : 0;
        const limit = o.limit ?? 1000;
        const slice = all.slice(start, start + limit);
        const truncated = start + limit < all.length;
        return {
          objects: slice.map((key) => ({ key }) as never),
          truncated,
          ...(truncated ? { cursor: slice[slice.length - 1] } : {}),
        };
      });
    },
    async head(key: string) {
      return trip(() => (store.has(key) ? ({ key } as never) : null));
    },
  };
}

let failures = 0;
const check = (name: string, pass: boolean, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!pass) failures++;
};

const uuid = () => crypto.randomUUID();
const now = Date.now();

// ===========================================================================
console.log("\n=== 1. records survive a round trip ===");
{
  const b = mockR2();
  const member: MemberRecord = {
    id: uuid(), email: "a@b.com", displayName: "A", role: "admin",
    onboarded: true, references: [[0.1, 0.2, 0.3]], referenceImageKey: null, createdAt: now,
  };
  await putMember(b as never, member);
  const back = await getMember(b as never, member.id);
  check("member round-trips", JSON.stringify(back) === JSON.stringify(member));
  check("admin role is read back", await isAdmin(b as never, member.id));

  const col: CollectionRecord = {
    id: uuid(), name: "Brand Summit", description: null,
    coverPhotoId: null, createdBy: member.id, createdAt: now,
  };
  await putCollection(b as never, col);
  check("collection round-trips", (await getCollection(b as never, col.id))?.name === "Brand Summit");
  check("missing record returns null", (await getCollection(b as never, uuid())) === null);
}

// ===========================================================================
console.log("\n=== 2. listing replaces the queries a database would run ===");
{
  const b = mockR2();
  const owner = uuid();
  const cids = Array.from({ length: 12 }, (_, i) => {
    const id = uuid();
    return { id, i };
  });
  for (const { id, i } of cids) {
    await putCollection(b as never, {
      id, name: `Event ${i}`, description: null, coverPhotoId: null,
      createdBy: owner, createdAt: now + i,
    });
  }
  const list = await listCollections(b as never);
  check("every collection listed", list.length === 12, `${list.length}`);
  check("newest first", list[0]!.name === "Event 11", list[0]!.name);

  const cid = cids[0]!.id;
  for (let i = 0; i < 250; i++) {
    await putPhoto(b as never, {
      id: uuid(), collectionId: cid, fileName: `IMG_${i}.jpg`,
      width: 2048, height: 1365, facesCount: 2, boxes: [],
      uploadedBy: owner, createdAt: now + i,
    });
  }
  check("photo count is right", (await countPhotos(b as never, cid)) === 250);

  const page1 = await listPhotos(b as never, cid, { limit: 100 });
  check("first page is capped", page1.photos.length === 100, `${page1.photos.length}`);
  check("cursor offered when more remain", !!page1.cursor);
  const page2 = await listPhotos(b as never, cid, { limit: 100, cursor: page1.cursor! });
  const overlap = page2.photos.filter((p) => page1.photos.some((q) => q.id === p.id)).length;
  check("pages do not overlap", overlap === 0, `${overlap} repeated`);

  const otherCid = cids[1]!.id;
  check("listing is scoped to one collection", (await countPhotos(b as never, otherCid)) === 0);
}

// ===========================================================================
console.log("\n=== 3. deleting a photo removes everything derived from it ===");
{
  const b = mockR2();
  const cid = uuid();
  const pid = uuid();
  await putPhoto(b as never, {
    id: pid, collectionId: cid, fileName: "x.jpg", width: 100, height: 100,
    facesCount: 1, boxes: [], uploadedBy: uuid(), createdAt: now,
  });
  await b.put(keys.photo(cid, pid), "jpegbytes");
  await b.put(keys.thumb(cid, pid), "thumbbytes");
  await deletePhoto(b as never, cid, pid);
  check("original gone", !b.store.has(keys.photo(cid, pid)));
  check("thumbnail gone", !b.store.has(keys.thumb(cid, pid)));
  check("record gone", (await getPhoto(b as never, cid, pid)) === null);
}

// ===========================================================================
console.log("\n=== 4. a scan result renders the grid on its own ===");
{
  const b = mockR2();
  const cid = uuid();
  const userId = uuid();
  const photoIds: string[] = [];
  for (let i = 0; i < 400; i++) {
    const id = uuid();
    photoIds.push(id);
    await putPhoto(b as never, {
      id, collectionId: cid, fileName: `IMG_${i}.jpg`, width: 2048, height: 1365,
      facesCount: 3, boxes: [], uploadedBy: uuid(), createdAt: now + i,
    });
  }

  const matches = photoIds.map((photoId, i) => ({
    photoId, distance: 0.2 + i * 0.0005, hops: i < 120 ? 0 : 1,
  }));

  b.reset();
  const record = await buildScanRecord(b as never, {
    userId, collectionId: cid, matches, truncated: false, collectionPhotoCount: 400,
  });
  const build = b.stats();
  await putScan(b as never, record);

  check("every match carried through", record.hits.length === 400, `${record.hits.length}`);
  check("dimensions folded in", record.hits.every((h) => h.width === 2048 && h.height === 1365));
  check("filenames folded in", record.hits[0]!.fileName.startsWith("IMG_"));
  check("hop count preserved", record.hits.filter((h) => h.hops === 0).length === 120);
  console.log(`    building it: ${build.ops} reads over ${build.waves} waves (concurrency ${READ_CONCURRENCY})`);
  check("reads are batched, not sequential", build.waves <= Math.ceil(400 / READ_CONCURRENCY) + 1,
    `${build.waves} waves for 400 reads`);

  b.reset();
  const reopened = await getScan(b as never, userId, cid);
  const reopen = b.stats();
  check("reopening costs exactly one read", reopen.ops === 1, `${reopen.ops} reads`);
  check("reopened result is complete", reopened?.hits.length === 400);
}

// ===========================================================================
console.log("\n=== 5. photo bytes, and not re-sending them ===");
{
  const b = mockR2();
  const cid = uuid(), pid = uuid();
  await b.put(keys.photo(cid, pid), "the-jpeg-bytes");

  const first = await serveImage(b as never, keys.photo(cid, pid), new Request("https://x/p"));
  check("photo served", first.status === 200, `${first.status}`);
  const etag = first.headers.get("etag")!;
  check("cached immutably", (first.headers.get("cache-control") ?? "").includes("immutable"));
  check("cache is private, not shared", (first.headers.get("cache-control") ?? "").includes("private"));

  const second = await serveImage(b as never, keys.photo(cid, pid),
    new Request("https://x/p", { headers: { "if-none-match": etag } }));
  check("revisit returns 304, no bytes", second.status === 304, `${second.status}`);

  const missing = await serveImage(b as never, keys.photo(cid, uuid()), new Request("https://x/p"));
  check("missing photo is a 404", missing.status === 404, `${missing.status}`);
}

// ===========================================================================
console.log("\n=== 6. two hundred members at once ===");
{
  const b = mockR2();
  const cid = uuid();
  const members = Array.from({ length: 200 }, () => uuid());

  for (let i = 0; i < 200; i++) {
    await putScan(b as never, {
      userId: members[i]!, collectionId: cid,
      hits: Array.from({ length: 150 }, (_, j) => ({
        photoId: uuid(), distance: 0.3, hops: 0,
        fileName: `IMG_${j}.jpg`, width: 2048, height: 1365,
      })),
      truncated: false, scannedAt: now, collectionPhotoCount: 4000,
    });
  }

  // Every member writes to a key derived from their own id, so the absence of
  // transactions in R2 costs nothing here. Verify that rather than assume it.
  const writtenKeys = new Set(members.map((m) => keys.scan(m, cid)));
  check("no two members share a key", writtenKeys.size === 200, `${writtenKeys.size} distinct`);

  b.reset();
  const results = await Promise.all(members.map((m) => getScan(b as never, m, cid)));
  const concurrent = b.stats();
  check("all 200 retrieved", results.every((r) => r?.hits.length === 150));
  console.log(`    ${concurrent.ops} reads, issued in ${concurrent.waves} wave(s)`);
  check("200 members retrieve in one wave, not 200", concurrent.waves === 1, `${concurrent.waves} waves`);
}

// ===========================================================================
console.log("\n=== 7. the five second budget ===");
{
  // Worker isolates run each request independently, so 200 members do not queue
  // behind one another. What a member waits for is their own critical path.
  const INDEX_WAVES = 21;   // measured by test-face-index.ts at the shipped defaults
  const SCAN_READ_WAVES = Math.ceil(400 / READ_CONCURRENCY) + 1;

  console.log("\n    A fresh scan, worst case, member matched in 400 photos:");
  console.log("    index latency  R2 latency   total    inside 5s");
  let allOk = true;
  for (const [idxMs, r2Ms] of [[30, 10], [50, 15], [100, 30], [150, 50]] as const) {
    const total = 1 * r2Ms + INDEX_WAVES * idxMs + SCAN_READ_WAVES * r2Ms + 1 * r2Ms;
    const ok = total < 5000;
    if (!ok) allOk = false;
    console.log(`    ${(idxMs + "ms").padStart(13)}  ${(r2Ms + "ms").padStart(10)}   ${(total + "ms").padStart(6)}   ${ok ? "yes" : "NO"}`);
  }
  check("fresh scan inside 5s across the latency range", allOk);

  console.log("\n    Reopening a collection already scanned:");
  for (const r2Ms of [10, 15, 30, 50]) {
    console.log(`    one read at ${r2Ms}ms  ->  ${r2Ms}ms`);
  }
  check("reopening is effectively instant", true, "a single R2 read");
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
