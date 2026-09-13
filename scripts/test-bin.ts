/**
 * The recycle bin.
 *
 *   npm run test:bin
 *
 * Runs against an in-memory bucket and index rather than the live ones, so it
 * can delete, restore and purge freely, and can move the clock thirty days on.
 *
 * The failures that matter here are quiet ones: a restored photo that comes
 * back without its faces in the search, a "deleted" photo that still turns up
 * in someone's results, an event purged along with photos that belonged to
 * nobody, or a restore that half happens. So most checks look at the storage
 * underneath rather than at what a function returned.
 */

import {
  BIN_RETENTION_MS,
  BinError,
  DESCRIPTOR_DIM,
  binPhotos,
  deleteForever,
  facesKey,
  handleMediaRequest,
  listBin,
  photoKey,
  photoMetaKey,
  purgeExpired,
  readBinGroup,
  restoreFromBin,
  thumbKey,
  trashEvent,
  trashPhotos,
  type MediaEnv,
} from "../src/lib/media.server.ts";
import { indexPhotoFaces } from "../src/lib/face-index.server.ts";
import { createSessionToken, sessionCookieHeader, SESSION_COOKIE } from "../src/lib/auth/session.ts";
import { createMember } from "../src/lib/auth/members.server.ts";

let failures = 0;
const check = (name: string, pass: boolean, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!pass) failures++;
};

const DAY = 24 * 60 * 60 * 1000;
const SECRET = "test-session-secret-long-enough-for-hmac";

/* ------------------------------ test doubles ------------------------------ */

function memoryBucket() {
  const store = new Map<string, string>();
  const object = (key: string, body: string) => ({
    key,
    size: body.length,
    etag: "e",
    httpEtag: '"e"',
    uploaded: new Date(),
    body: body as never,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    text: async () => body,
    json: async <T,>() => JSON.parse(body) as T,
    writeHttpMetadata: () => {},
  });
  return {
    store,
    async get(key: string) {
      const body = store.get(key);
      return body === undefined ? null : object(key, body);
    },
    async head(key: string) {
      const body = store.get(key);
      return body === undefined ? null : object(key, body);
    },
    async put(key: string, value: unknown) {
      store.set(key, value instanceof ArrayBuffer ? `<${value.byteLength} bytes>` : String(value));
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
    async list(opts: { prefix?: string; cursor?: string; limit?: number } = {}) {
      const all = [...store.keys()].filter((k) => k.startsWith(opts.prefix ?? "")).sort();
      const start = opts.cursor ? Number(opts.cursor) : 0;
      const limit = opts.limit ?? 1000;
      const page = all.slice(start, start + limit);
      const truncated = start + limit < all.length;
      return {
        objects: page.map((key) => ({ key })),
        truncated,
        ...(truncated ? { cursor: String(start + limit) } : {}),
      };
    },
    count(prefix: string) {
      return [...store.keys()].filter((k) => k.startsWith(prefix)).length;
    },
  };
}

function memoryIndex() {
  const vectors = new Map<string, number[]>();
  return {
    vectors,
    async upsert(items: { id: string; values: number[] }[]) {
      for (const v of items) vectors.set(v.id, v.values);
      return { mutationId: "m" };
    },
    async deleteByIds(ids: string[]) {
      for (const id of ids) vectors.delete(id);
      return { mutationId: "m" };
    },
    async query() {
      return { matches: [] };
    },
    async getByIds() {
      return [];
    },
    forPhoto(photoId: string) {
      return [...vectors.keys()].filter((id) => id.includes(photoId)).length;
    },
  };
}

function unitVector(seed: number): number[] {
  const v = Array.from({ length: DESCRIPTOR_DIM }, (_, i) => Math.sin(seed * 7.13 + i * 0.37));
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

/** An event with photos in it, each with two faces in the index. */
async function seedEvent(env: MediaEnv, name: string, photoCount: number, startAt = Date.now()) {
  const bucket = env.PHOTOS as unknown as ReturnType<typeof memoryBucket>;
  const cid = crypto.randomUUID();
  await bucket.put(`meta/collection/${cid}`, JSON.stringify({ id: cid, name, createdAt: startAt }));
  const ids: string[] = [];
  for (let i = 0; i < photoCount; i++) {
    const pid = crypto.randomUUID();
    ids.push(pid);
    await bucket.put(photoKey(cid, pid), new ArrayBuffer(1000));
    await bucket.put(thumbKey(cid, pid), new ArrayBuffer(100));
    await bucket.put(
      photoMetaKey(cid, pid),
      JSON.stringify({ id: pid, collectionId: cid, fileName: `IMG_${i}.jpg`, width: 2048, height: 1365, createdAt: startAt + i * 1000 }),
    );
    const descriptors = [unitVector(i + 1), unitVector(i + 101)];
    await bucket.put(
      facesKey(cid, pid),
      JSON.stringify({
        photoId: pid,
        collectionId: cid,
        indexedAt: startAt,
        faces: descriptors.map((descriptor) => ({ box: { x: 0, y: 0, width: 100, height: 100 }, score: 0.9, descriptor })),
      }),
    );
    await indexPhotoFaces(env.FACE_INDEX!, { collectionId: cid, photoId: pid, descriptors });
  }
  return { cid, ids };
}

function freshEnv() {
  const bucket = memoryBucket();
  const index = memoryIndex();
  const env: MediaEnv = { PHOTOS: bucket as never, FACE_INDEX: index as never, SESSION_SECRET: SECRET };
  return { env, bucket, index };
}

const gallery = (b: ReturnType<typeof memoryBucket>, cid: string) => b.count(`meta/photo/${cid}/`);

// ===========================================================================
console.log("\n=== 1. deleting photos moves them to the bin ===");
{
  const { env, bucket, index } = freshEnv();
  const { cid, ids } = await seedEvent(env, "Career Nexus", 6);

  // Two slices of one selection, the second joining the first's entry.
  const first = await trashPhotos(env, { collectionId: cid, photoIds: ids.slice(0, 2), userId: "admin" });
  const second = await trashPhotos(env, {
    collectionId: cid,
    photoIds: ids.slice(2, 4),
    userId: "admin",
    groupId: first.groupId!,
  });

  check("the second slice joins the first entry", second.groupId === first.groupId);
  const group = await readBinGroup(env, first.groupId!);
  check("one entry holds the whole selection", group?.photoIds.length === 4, `${group?.photoIds.length}`);
  check("they leave the gallery", gallery(bucket, cid) === 2, `${gallery(bucket, cid)} left`);
  check("their records wait in the bin", bucket.count(`trash/photo/${cid}/`) === 4);
  check("their faces wait in the bin", bucket.count(`trash/faces/${cid}/`) === 4);
  check("they leave the search at once", ids.slice(0, 4).every((id) => index.forPhoto(id) === 0));
  check("photos not deleted keep their faces in the search", ids.slice(4).every((id) => index.forPhoto(id) === 2));
  check("the images themselves are untouched", ids.every((id) => bucket.store.has(photoKey(cid, id))));
  check("it expires thirty days after it was deleted", group!.expiresAt - group!.deletedAt === BIN_RETENTION_MS);
  check("the entry names the event", group?.collectionName === "Career Nexus");

  const nothing = await trashPhotos(env, { collectionId: cid, photoIds: [crypto.randomUUID()], userId: "admin" });
  check("deleting a photo that is not there makes no entry", nothing.groupId === null && nothing.moved === 0);

  let refused = false;
  const other = await seedEvent(env, "Other", 1);
  try {
    await trashPhotos(env, { collectionId: other.cid, photoIds: other.ids, userId: "admin", groupId: first.groupId! });
  } catch (e) {
    refused = e instanceof BinError && e.status === 400;
  }
  check("an entry cannot collect photos from a different event", refused);
}

// ===========================================================================
console.log("\n=== 2. listing the bin ===");
{
  const { env } = freshEnv();
  const { cid, ids } = await seedEvent(env, "Listing", 5);
  await trashPhotos(env, { collectionId: cid, photoIds: ids.slice(0, 3), userId: "admin", now: Date.now() - 2 * DAY });
  await trashPhotos(env, { collectionId: cid, photoIds: ids.slice(3), userId: "admin" });

  const groups = await listBin(env);
  check("every entry is listed", groups.length === 2, `${groups.length}`);
  check("newest deletion first", groups[0]!.deletedAt > groups[1]!.deletedAt);
  check("each carries a preview", groups[1]!.preview.length === 3);
  const photos = await binPhotos(env, groups[1]!);
  check("an entry's photos come back newest first", photos[0]!.createdAt > photos[2]!.createdAt);
  check("with addresses the console can show", photos[0]!.thumbUrl.startsWith("/media/t/"));
}

// ===========================================================================
console.log("\n=== 3. restoring ===");
{
  const { env, bucket, index } = freshEnv();
  const { cid, ids } = await seedEvent(env, "Restore", 4);
  const { groupId } = await trashPhotos(env, { collectionId: cid, photoIds: ids, userId: "admin" });

  const one = await restoreFromBin(env, groupId!, [ids[1]!]);
  check("restoring one photo restores one", one.restored === 1 && one.remaining === 3, JSON.stringify(one));
  check("it is back in the gallery", bucket.store.has(photoMetaKey(cid, ids[1]!)));
  check("its faces are back in the search", index.forPhoto(ids[1]!) === 2, `${index.forPhoto(ids[1]!)} vectors`);
  check("its faces are marked indexed again", JSON.parse(bucket.store.get(facesKey(cid, ids[1]!))!).indexedAt > 0);
  check("it is no longer in the bin", !bucket.store.has(`trash/photo/${cid}/${ids[1]}`));
  check("the rest stay in the bin", (await readBinGroup(env, groupId!))?.photoIds.length === 3);

  const rest = await restoreFromBin(env, groupId!);
  check("restoring the rest brings back all of them", rest.restored === 3 && rest.remaining === 0);
  check("the gallery is whole again", gallery(bucket, cid) === 4);
  check("the empty entry is gone", (await readBinGroup(env, groupId!)) === null);
  check("every face is searchable again", ids.every((id) => index.forPhoto(id) === 2));

  let missing = false;
  try {
    await restoreFromBin(env, groupId!);
  } catch (e) {
    missing = e instanceof BinError && e.status === 404;
  }
  check("restoring an entry twice says it is gone", missing);

  let bad = false;
  try {
    await restoreFromBin(env, "../../meta/member/x");
  } catch (e) {
    bad = e instanceof BinError;
  }
  check("an id shaped like a path is refused", bad);
}

// ===========================================================================
console.log("\n=== 4. deleting for good ===");
{
  const { env, bucket } = freshEnv();
  const { cid, ids } = await seedEvent(env, "Purge", 3);
  const { groupId } = await trashPhotos(env, { collectionId: cid, photoIds: ids, userId: "admin" });

  const r = await deleteForever(env, groupId!, [ids[0]!]);
  check("one photo deleted for good", r.deleted === 1 && r.remaining === 2);
  check("its image is gone", !bucket.store.has(photoKey(cid, ids[0]!)));
  check("its thumbnail is gone", !bucket.store.has(thumbKey(cid, ids[0]!)));
  check("its bin records are gone", !bucket.store.has(`trash/photo/${cid}/${ids[0]}`) && !bucket.store.has(`trash/faces/${cid}/${ids[0]}`));
  check("the others are still restorable", bucket.store.has(photoKey(cid, ids[1]!)));

  await deleteForever(env, groupId!);
  check("emptying the entry removes it", (await readBinGroup(env, groupId!)) === null);
  check("nothing of those photos is left anywhere", ![...bucket.store.keys()].some((k) => ids.some((id) => k.includes(id))));
  check("the event itself is unharmed", bucket.store.has(`meta/collection/${cid}`));
}

// ===========================================================================
console.log("\n=== 5. deleting a whole event ===");
{
  const { env, bucket, index } = freshEnv();
  const { cid, ids } = await seedEvent(env, "Whole event", 5);
  const early = await trashPhotos(env, { collectionId: cid, photoIds: [ids[0]!], userId: "admin" });

  const { groupId, photoCount } = await trashEvent(env, { collectionId: cid, userId: "admin" });
  check("the event leaves the list of events", !bucket.store.has(`meta/collection/${cid}`));
  check("its record waits in the bin", bucket.store.has(`trash/collection/${cid}`));
  check("the entry counts the photos it held", photoCount === 4, `${photoCount}`);
  check("its photos are not touched one by one", gallery(bucket, cid) === 4);

  let order = "";
  try {
    await restoreFromBin(env, early.groupId!);
  } catch (e) {
    order = e instanceof Error ? e.message : "";
  }
  check("photos of a deleted event ask for the event first", /Restore the event first/.test(order), order);

  await restoreFromBin(env, groupId);
  check("restoring the event brings it straight back", bucket.store.has(`meta/collection/${cid}`));
  check("with every photo it had", gallery(bucket, cid) === 4);
  const now = await restoreFromBin(env, early.groupId!);
  check("then the earlier photos can follow", now.restored === 1 && gallery(bucket, cid) === 5);

  // For good, this time, with a separate earlier deletion from the same event.
  const again = await trashPhotos(env, { collectionId: cid, photoIds: [ids[1]!], userId: "admin" });
  const gone = await trashEvent(env, { collectionId: cid, userId: "admin" });
  await deleteForever(env, gone.groupId);
  check("deleting an event for good removes every image", ![...bucket.store.keys()].some((k) => k.startsWith(`photo/${cid}/`) || k.startsWith(`thumb/${cid}/`)));
  check("and every record", ![...bucket.store.keys()].some((k) => k.includes(cid)), [...bucket.store.keys()].filter((k) => k.includes(cid)).join(", "));
  check("and every face in the search", ids.every((id) => index.forPhoto(id) === 0));
  check("and the earlier deletion from it, which has nowhere to return to", (await readBinGroup(env, again.groupId!)) === null);

  let unknown = false;
  try {
    await trashEvent(env, { collectionId: crypto.randomUUID(), userId: "admin" });
  } catch (e) {
    unknown = e instanceof BinError && e.status === 404;
  }
  check("deleting an event that does not exist is refused", unknown);
}

// ===========================================================================
console.log("\n=== 6. thirty days on ===");
{
  const { env, bucket } = freshEnv();
  const { cid, ids } = await seedEvent(env, "Expiry", 3);
  const old = await trashPhotos(env, { collectionId: cid, photoIds: [ids[0]!], userId: "admin", now: Date.now() - 31 * DAY });
  const recent = await trashPhotos(env, { collectionId: cid, photoIds: [ids[1]!], userId: "admin", now: Date.now() - 29 * DAY });

  const purged = await purgeExpired(env);
  check("anything past thirty days is cleared", purged === 1, `${purged} purged`);
  check("its entry is gone", (await readBinGroup(env, old.groupId!)) === null);
  check("its image is gone", !bucket.store.has(photoKey(cid, ids[0]!)));
  check("a day short of thirty is kept", (await readBinGroup(env, recent.groupId!)) !== null);
  check("and still restorable", (await restoreFromBin(env, recent.groupId!)).restored === 1);
  check("the gallery was never touched", bucket.store.has(photoMetaKey(cid, ids[2]!)));

  const deletedEvent = await seedEvent(env, "Old event", 2);
  const ev = await trashEvent(env, { collectionId: deletedEvent.cid, userId: "admin", now: Date.now() - 40 * DAY });
  await purgeExpired(env);
  check("an expired event is cleared with its photos", (await readBinGroup(env, ev.groupId)) === null && gallery(bucket, deletedEvent.cid) === 0);
}

// ===========================================================================
console.log("\n=== 7. the delete route ===");
{
  const { env, bucket } = freshEnv();
  const { cid, ids } = await seedEvent(env, "Route", 3);

  const cookieFor = async (role: "admin" | "member") => {
    const created = await createMember(bucket as never, {
      email: `${role}@test.com`,
      password: "password2026",
      fullName: "Test Person",
      phone: "9876543210",
      role,
    });
    if (!created.ok) throw new Error("could not create the test account");
    const token = await createSessionToken(created.member.id, SECRET);
    return sessionCookieHeader(token).split(";")[0]!;
  };
  const post = (cookie: string, body: unknown) =>
    handleMediaRequest(
      new Request("https://gallery.test/media/delete", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
    );

  const member = await post(await cookieFor("member"), { collection: cid, photos: ids });
  check("a member cannot delete", member?.status === 403, `${member?.status}`);
  check("and nothing moved", gallery(bucket, cid) === 3);

  const admin = await cookieFor("admin");
  const res = await post(admin, { collection: cid, photos: [ids[0]] });
  const body = (await res!.json()) as { deleted: number; groupId: string | null };
  check("an operator's delete answers with the bin entry", res?.status === 200 && !!body.groupId, JSON.stringify(body));
  check("and the photo went to the bin, not away", bucket.store.has(photoKey(cid, ids[0]!)) && !bucket.store.has(photoMetaKey(cid, ids[0]!)));

  const tooMany = await post(admin, { collection: cid, photos: Array.from({ length: 101 }, () => crypto.randomUUID()) });
  check("more than a slice at once is refused", tooMany?.status === 413, `${tooMany?.status}`);

  const whole = await post(admin, { collection: cid });
  const wholeBody = (await whole!.json()) as { collectionRemoved: boolean; groupId: string };
  check("deleting the event answers with its entry", wholeBody.collectionRemoved && !!wholeBody.groupId);
  check("using the session cookie name the app sets", SESSION_COOKIE.length > 0);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
