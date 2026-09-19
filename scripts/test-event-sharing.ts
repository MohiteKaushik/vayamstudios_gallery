import assert from "node:assert/strict";
import { handleApiRequest } from "../src/lib/api.server.ts";
import { handleMediaRequest, type MediaEnv } from "../src/lib/media.server.ts";
import { createSessionToken, SESSION_COOKIE } from "../src/lib/auth/session.ts";
import { LEGACY_RECENT_EVENT_ID } from "../src/lib/vayam.ts";
import { safeShareReturn } from "../src/lib/share-return.ts";

const admin = crypto.randomUUID(), member = crypto.randomUUID(), album = crypto.randomUUID(), other = crypto.randomUUID();
const ids = Array.from({ length: 45 }, () => crypto.randomUUID());
const data = new Map<string, unknown>([
  [`meta/member/${admin}`, { id: admin, role: "admin" }],
  [`meta/member/${member}`, { id: member, role: "member" }],
  [`meta/collection/${album}`, { id: album, name: "Day one", createdAt: 1, createdBy: "PRIVATE" }],
  [`meta/collection/${other}`, { id: other, name: "Other", showcaseEventId: other, createdAt: 1 }],
]);
for (const id of ids) {
  data.set(`meta/photo/${album}/${id}`, { id, fileName: "Original.jpg", width: 3000, height: 2000, fingerprint: "PRIVATE", facesCount: 9 });
  data.set(`thumb/${album}/${id}`, "thumbnail bytes");
  data.set(`photo/${album}/${id}`, "ORIGINAL BYTES");
}
const env = { SESSION_SECRET: "sharing-test", PHOTOS: {
  get: async (key: string) => {
    if (!data.has(key)) return null;
    const value = data.get(key);
    return { json: async () => value, body: new Response(String(value)).body,
      writeHttpMetadata: (h: Headers) => h.set("content-type", "image/jpeg") };
  },
  head: async (key: string) => data.has(key) ? {} : null,
  put: async (key: string, value: string) => { data.set(key, JSON.parse(value)); },
  list: async ({ prefix, cursor, limit = 1000 }: { prefix: string; cursor?: string; limit?: number }) => {
    const keys = [...data.keys()].filter((k) => k.startsWith(prefix));
    const start = Number(cursor ?? 0), end = start + limit;
    return { objects: keys.slice(start, end).map((key) => ({ key })), truncated: end < keys.length, cursor: end < keys.length ? String(end) : undefined };
  },
} } as unknown as MediaEnv;
const adminToken = await createSessionToken(admin, env.SESSION_SECRET!);
const memberToken = await createSessionToken(member, env.SESSION_SECRET!);
async function request(path: string, method = "GET", token?: string, body?: unknown) {
  return (await handleApiRequest(new Request("https://local/api/" + path, {
    method, headers: { "content-type": "application/json", ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), env))!;
}
const body = { id: LEGACY_RECENT_EVENT_ID };
assert.equal((await request("site/events/share", "POST", undefined, body)).status, 401);
assert.equal((await request("site/events/share", "POST", memberToken, body)).status, 403);
const shared = await (await request("site/events/share", "POST", adminToken, body)).json() as { path: string };
const token = shared.path.split("/").pop()!;
assert.deepEqual(await (await request("site/events/share", "POST", adminToken, body)).json(), shared);
const root = "share/" + token;
const metadata = await (await request(root)).text();
assert.ok(metadata.includes("Day one"));
assert.ok(!metadata.includes("PRIVATE"));
assert.ok(!metadata.includes("Other"));
assert.equal((await request(root, "POST")).status, 405);
assert.equal((await request("share/" + crypto.randomUUID())).status, 404);
const page = await (await request(`${root}/photos/${album}`)).json() as { photos: { id: string; fullUrl: string }[]; cursor: string };
assert.equal(page.photos.length, 40);
assert.ok(page.photos.every((p) => p.fullUrl.startsWith("/api/share/")));
assert.ok(!JSON.stringify(page).includes("PRIVATE"));
const next = await (await request(`${root}/photos/${album}?cursor=${page.cursor}`)).json() as { photos: { id: string }[] };
assert.equal(next.photos.length, 5);
assert.equal(new Set([...page.photos, ...next.photos].map((p) => p.id)).size, 45);
assert.equal((await request(`${root}/photos/${other}`)).status, 404);
const preview = `${root}/preview/${album}/${ids[0]}`;
const response = await request(preview);
assert.equal(await response.text(), "thumbnail bytes");
assert.equal(response.headers.get("cache-control"), "no-store");
assert.equal(await (await request(preview, "HEAD")).text(), "");
assert.equal((await request(`${root}/preview/${other}/${ids[0]}`)).status, 404);
data.delete(`thumb/${album}/${ids[0]}`);
assert.equal((await request(preview)).status, 404, "No original fallback");
data.set(`thumb/${album}/${ids[0]}`, "thumbnail bytes");
for (const setting of [{ hidden: true }, { deleted: true }]) {
  data.set(`site/recent-events/${LEGACY_RECENT_EVENT_ID}`, setting);
  for (const path of [root, preview, `${root}/photos/${album}`]) assert.equal((await request(path)).status, 404);
}
data.delete(`site/recent-events/${LEGACY_RECENT_EVENT_ID}`);
assert.equal((await request(preview)).status, 200);
data.delete(`meta/photo/${album}/${ids[0]}`);
assert.equal((await request(preview)).status, 404);
assert.equal((await request("scan", "POST")).status, 401);
assert.equal((await handleMediaRequest(new Request(`https://local/media/p/${album}/${ids[1]}`), env))!.status, 401);
assert.equal(safeShareReturn(shared.path), shared.path);
for (const value of ["//evil.test", "https://evil.test", "/home", shared.path + "?redirect=//evil.test"]) assert.equal(safeShareReturn(value), null);
console.log("Sharing passed: admin-only creation, guest previews, album isolation, pagination, hide/delete enforcement, no original fallback, protected downloads/scan, safe sign-in return.");
