import assert from "node:assert/strict";
import { handleApiRequest } from "../src/lib/api.server.ts";
import { createSessionToken, SESSION_COOKIE } from "../src/lib/auth/session.ts";
import { LEGACY_RECENT_EVENT_ID, type ShowcaseEvent } from "../src/lib/vayam.ts";
import { restoreFromBin, deleteForever, type MediaEnv } from "../src/lib/media.server.ts";
import { confirmEventDeletion } from "../src/lib/confirm-event-deletion.ts";

const admin = crypto.randomUUID(), member = crypto.randomUUID(), legacy = crypto.randomUUID();
const records = new Map<string, unknown>([
  [`meta/member/${admin}`, { id: admin, role: "admin" }],
  [`meta/member/${member}`, { id: member, role: "member" }],
  [`meta/collection/${legacy}`, { id: legacy, name: "TTPOC Day 1", createdAt: 1 }],
  ["site/past-events.json", { renames: { "district-150-ioniq-connect": "District 150" } }],
  [`meta/photo/${legacy}/original-photo`, { id: "original-photo", fileName: "original.jpg" }],
]);
const originalPhoto = records.get(`meta/photo/${legacy}/original-photo`);
let failWriteKey: string | null = null;
const env = { SESSION_SECRET: "recent-events-test-only", PHOTOS: {
  get: async (key: string) => records.has(key) ? { json: async () => records.get(key) } : null,
  head: async (key: string) => records.has(key) ? {} : null,
  put: async (key: string, body: string) => {
    if (key === failWriteKey) { failWriteKey = null; throw new Error("Simulated storage failure"); }
    records.set(key, JSON.parse(body));
  },
  delete: async (key: string | string[]) => { for (const k of Array.isArray(key) ? key : [key]) records.delete(k); },
  list: async ({ prefix }: { prefix: string }) => ({ objects: [...records.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })), truncated: false }),
} } as unknown as MediaEnv;
const adminToken = await createSessionToken(admin, env.SESSION_SECRET!);
const memberToken = await createSessionToken(member, env.SESSION_SECRET!);
async function request(path: string, method = "GET", body?: unknown, token: string | null = adminToken) {
  return (await handleApiRequest(new Request(`https://test.local/api/${path}`, {
    method, headers: { "content-type": "application/json", ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }), env))!;
}
async function events() { return (await (await request("site/events")).json() as { events: ShowcaseEvent[] }).events; }
async function recentIds() {
  const result = await (await request("collections?recent=1", "GET", undefined, memberToken)).json() as { collections: { id: string }[] };
  return result.collections.map((c) => c.id).sort();
}
assert.equal((await request("site/events", "GET", undefined, null)).status, 401);
assert.equal((await request("site/events", "PATCH", { id: LEGACY_RECENT_EVENT_ID, recent: false }, memberToken)).status, 403);
assert.equal((await request("collections", "POST", { name: "Denied" }, memberToken)).status, 403);
const initial = await events();
assert.deepEqual(initial.find((e) => e.id === LEGACY_RECENT_EVENT_ID)?.collectionIds, [legacy]);
assert.equal(initial.find((e) => e.id === "district-150-ioniq-connect")?.name, "District 150");
assert.equal(initial.find((e) => e.id === "careernexus-2024")?.name, "CareerNexus 2024");
assert.deepEqual(await recentIds(), [legacy]);
const created = await request("collections", "POST", { name: "New conference", recent: true });
assert.equal(created.status, 201);
const first = await created.json() as { id: string };
const second = await (await request("collections", "POST", { name: "Private launch", recent: false })).json() as { id: string };
assert.deepEqual(await recentIds(), [legacy, first.id].sort());
assert.equal((await events()).find((e) => e.id === second.id)?.recent, false);
assert.equal((await request("site/events", "PATCH", { id: second.id, recent: true })).status, 200);
assert.deepEqual(await recentIds(), [legacy, first.id, second.id].sort());
await request("site/events", "PATCH", { id: first.id, recent: false });
assert.deepEqual(await recentIds(), [legacy, second.id].sort());
await request("site/events", "PATCH", { id: LEGACY_RECENT_EVENT_ID, recent: false });
assert.deepEqual(await recentIds(), [second.id]);
assert.equal(records.get(`meta/photo/${legacy}/original-photo`), originalPhoto, "Visibility must not touch photos");
assert.ok(records.has(`meta/collection/${first.id}`), "Hiding does not delete an event");
await request("site/events", "PATCH", { id: "district-150-ioniq-connect", recent: true });
const district = (await events()).find((e) => e.id === "district-150-ioniq-connect")!;
assert.equal(district.collectionIds.length, 1);
await request("site/events", "PATCH", { id: district.id, recent: false });
await request("site/events", "PATCH", { id: district.id, recent: true });
assert.deepEqual((await events()).find((e) => e.id === district.id)?.collectionIds, district.collectionIds);
await request("site/past-events", "PUT", { id: first.id, title: "Renamed conference" });
assert.equal((await events()).find((e) => e.id === first.id)?.name, "Renamed conference");
assert.equal((await events()).find((e) => e.id === first.id)?.recent, false);
await request("site/past-events", "PUT", { id: district.id, title: "District renamed" });
assert.equal((await events()).find((e) => e.id === district.id)?.recent, true);
for (const body of [null, {}, { id: first.id, recent: "true" }]) assert.equal((await request("site/events", "PATCH", body)).status, 400);
assert.equal((await request("site/events", "PATCH", { id: "../../private", recent: true })).status, 404);
assert.equal((await request("collections", "POST", null)).status, 400);
assert.equal((await request("collections", "POST", { name: 123 })).status, 400);
const all = await (await request("collections")).json() as { collections: unknown[] };
assert.equal(all.collections.length, 4, "Admins can still manage hidden events");
console.log("Recent events: legacy galleries and renames preserved, creation, multiple selections, hiding without deletion, repeated toggles, custom renaming, validation and admin permissions passed.");

for (const answers of [[false], [true, false], [true, true]]) {
  const prompts: string[] = [];
  const approved = await confirmEventDeletion(async (options) => {
    prompts.push(options.title);
    return answers[prompts.length - 1] ?? false;
  }, "Test event");
  assert.equal(prompts.length, answers.length);
  assert.equal(approved, answers.length === 2 && answers[1]);
}
assert.equal((await request("site/events", "DELETE", { id: first.id, confirmed: true }, memberToken)).status, 403);
assert.equal((await request("site/events", "DELETE", { id: first.id, confirmed: true }, null)).status, 401);
assert.equal((await request("site/events", "DELETE", { id: first.id })).status, 400);
assert.equal((await request("site/events", "DELETE", { id: "../../private", confirmed: true })).status, 404);
async function remove(id: string) {
  const response = await request("site/events", "DELETE", { id, confirmed: true });
  assert.equal(response.status, 200);
  return (await response.json() as { groupIds: string[] }).groupIds;
}
const customGroups = await remove(first.id);
assert.equal((await events()).some((e) => e.id === first.id), false);
assert.ok(records.has(`trash/collection/${first.id}`));
await restoreFromBin(env, customGroups[0]!);
assert.equal((await events()).find((e) => e.id === first.id)?.recent, false);
assert.equal((await events()).find((e) => e.id === first.id)?.name, "Renamed conference");

const day2 = crypto.randomUUID();
records.set(`meta/collection/${day2}`, { id: day2, name: "TTPOC Day 2", createdAt: 2 });
const originalKey = `photo/${legacy}/original-photo`;
records.set(originalKey, "untouched original bytes");
const legacyGroups = await remove(LEGACY_RECENT_EVENT_ID);
assert.equal(legacyGroups.length, 2, "Delete all associated day albums");
assert.equal((await events()).some((e) => e.id === LEGACY_RECENT_EVENT_ID), false);
assert.equal(records.has(`meta/collection/${legacy}`), false);
assert.equal(records.has(`meta/collection/${day2}`), false);
assert.equal(records.get(originalKey), "untouched original bytes");
assert.equal(records.get(`meta/photo/${legacy}/original-photo`), originalPhoto);
assert.equal((await recentIds()).includes(legacy), false);
for (const group of legacyGroups) await restoreFromBin(env, group);
assert.deepEqual((await events()).find((e) => e.id === LEGACY_RECENT_EVENT_ID)?.collectionIds.sort(), [legacy, day2].sort());

const emptyStatic = "careernexus-2024";
const emptyGroups = await remove(emptyStatic);
assert.equal((await events()).some((e) => e.id === emptyStatic), false);
await restoreFromBin(env, emptyGroups[0]!);
assert.equal((await events()).find((e) => e.id === emptyStatic)?.name, "CareerNexus 2024");
const finalGroups = await remove(emptyStatic);
await deleteForever(env, finalGroups[0]!);
assert.equal((await events()).some((e) => e.id === emptyStatic), false, "Permanent deletion must not resurrect static events");
assert.equal((await request("site/events", "DELETE", { id: emptyStatic, confirmed: true })).status, 404);
assert.ok(records.has(`meta/collection/${second.id}`), "Other events must stay untouched");
failWriteKey = `trash/collection/${day2}`;
assert.equal((await request("site/events", "DELETE", { id: LEGACY_RECENT_EVENT_ID, confirmed: true })).status, 500);
assert.ok(records.has(`meta/collection/${legacy}`), "Completed album deletion rolls back after another album fails");
assert.ok(records.has(`meta/collection/${day2}`));
assert.ok((await events()).some((e) => e.id === LEGACY_RECENT_EVENT_ID));
failWriteKey = `site/recent-events/${second.id}`;
assert.equal((await request("site/events", "DELETE", { id: second.id, confirmed: true })).status, 500);
assert.ok(records.has(`meta/collection/${second.id}`), "A failed catalog update restores the collection");
console.log("Event deletion: both confirmations, cancellation, admin authorization, custom/static/multi-album deletion, original-byte retention, restoration, and permanent deletion passed.");

async function eventAlbums(id: string) {
  const response = await request(`collections?event=${encodeURIComponent(id)}`, "GET", undefined, memberToken);
  assert.equal(response.status, 200);
  return await response.json() as { event: ShowcaseEvent; collections: { id: string }[] };
}
const ttpocAlbums = await eventAlbums(LEGACY_RECENT_EVENT_ID);
assert.equal(ttpocAlbums.event.id, LEGACY_RECENT_EVENT_ID);
assert.deepEqual(ttpocAlbums.collections.map((c) => c.id).sort(), [legacy, day2].sort());
const customAlbums = await eventAlbums(first.id);
assert.equal(customAlbums.event.name, "Renamed conference");
assert.deepEqual(customAlbums.collections.map((c) => c.id), [first.id], "A custom event must not include other events");
assert.deepEqual((await eventAlbums("conyape-retreat")).collections, [], "An empty event must not fall back to all albums");
for (const id of [emptyStatic, "unknown", "../../private", ""]) {
  assert.equal((await request(`collections?event=${encodeURIComponent(id)}`)).status, 404);
}
assert.equal((await request(`collections?event=${first.id}`, "GET", undefined, null)).status, 401);
console.log("Event-specific galleries: member access, single/multiple albums, isolation, empty/deleted/invalid events, and authentication passed.");
