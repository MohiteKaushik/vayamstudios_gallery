/**
 * Image routes: placement, access control and caching.
 *
 *   npm run test:media
 *
 * Most of these are refusals. The bucket has a public address, so the only
 * thing keeping event photographs of identifiable people private is that these
 * paths check a session first. A hole here is not a bug, it is a disclosure.
 */

import {
  handleMediaRequest,
  isSafeId,
  photoKey,
  thumbKey,
  photoMetaKey,
  mediaUrl,
  MEDIA_PREFIX,
  MAX_UPLOAD_BYTES,
  type MediaEnv,
} from "../src/lib/media.server.ts";
import { createSessionToken, sessionCookieHeader, SESSION_COOKIE } from "../src/lib/auth/session.ts";
import { createMember } from "../src/lib/auth/members.server.ts";

let failures = 0;
const check = (name: string, pass: boolean, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!pass) failures++;
};

const SECRET = "test-session-secret-long-enough-for-hmac";

function mockBucket() {
  const store = new Map<string, { body: string; type: string }>();
  return {
    store,
    async get(key: string) {
      const rec = store.get(key);
      if (!rec) return null;
      return {
        key,
        httpEtag: `"etag-${key.length}"`,
        body: rec.body as never,
        text: async () => rec.body,
        json: async <T,>() => JSON.parse(rec.body) as T,
        writeHttpMetadata: (h: Headers) => h.set("content-type", rec.type),
      } as never;
    },
    async head(key: string) {
      return store.has(key) ? ({ key } as never) : null;
    },
    async put(key: string, value: unknown, opts?: { httpMetadata?: { contentType?: string } }) {
      const body =
        value instanceof ArrayBuffer ? `<${value.byteLength} bytes>` : String(value);
      store.set(key, { body, type: opts?.httpMetadata?.contentType ?? "application/octet-stream" });
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
    async list() {
      return { objects: [], truncated: false };
    },
  };
}

const CID = crypto.randomUUID();
const PID = crypto.randomUUID();

async function envWith(role: "admin" | "member" | null) {
  const bucket = mockBucket();
  const env: MediaEnv = { PHOTOS: bucket as never, SESSION_SECRET: SECRET };
  let cookie = "";
  if (role) {
    const created = await createMember(bucket as never, {
      email: `${role}@test.com`,
      password: "password2026",
      fullName: "Test Person",
      phone: "9876543210",
      role,
    });
    if (!created.ok) throw new Error("setup failed");
    const token = await createSessionToken(created.member.id, SECRET);
    cookie = sessionCookieHeader(token, { secure: false });
  }
  bucket.store.set(photoKey(CID, PID), { body: "JPEGBYTES", type: "image/webp" });
  bucket.store.set(thumbKey(CID, PID), { body: "THUMBBYTES", type: "image/webp" });
  return { env, bucket, cookie: cookie.split(";")[0]! };
}

const get = (path: string, cookie?: string) =>
  new Request(`https://gallery.test${path}`, {
    headers: cookie ? { cookie } : {},
  });

// ===========================================================================
console.log("\n=== 1. key layout ===");
{
  check("photo key", photoKey("c", "p") === "photo/c/p");
  check("thumb key", thumbKey("c", "p") === "thumb/c/p");
  check("record key", photoMetaKey("c", "p") === "meta/photo/c/p");
  check("browser path", mediaUrl(CID, PID) === `${MEDIA_PREFIX}/p/${CID}/${PID}`);
  check("thumb path", mediaUrl(CID, PID, "t") === `${MEDIA_PREFIX}/t/${CID}/${PID}`);
  check("keys never collide across kinds", photoKey("c", "p") !== thumbKey("c", "p"));
}

console.log("\n=== 2. ids from a URL are not trusted ===");
{
  check("a uuid is fine", isSafeId(CID));
  check("traversal rejected", !isSafeId("../../meta/member"));
  check("slash rejected", !isSafeId("a/b"));
  check("empty rejected", !isSafeId(""));
  check("prefix of a uuid rejected", !isSafeId(CID.slice(0, 20)));
  check("uuid with a suffix rejected", !isSafeId(CID + "x"));
}

console.log("\n=== 3. non-media paths fall through untouched ===");
{
  const { env } = await envWith("member");
  for (const path of ["/", "/auth", "/collections", "/mediaish", "/media"]) {
    check(`${path} falls through`, (await handleMediaRequest(get(path), env)) === null);
  }
}

console.log("\n=== 4. photos require a session ===");
{
  const anon = await envWith(null);
  const signedIn = await envWith("member");

  const denied = await handleMediaRequest(get(mediaUrl(CID, PID)), anon.env);
  check("no cookie is refused", denied?.status === 401, String(denied?.status));

  const forged = await handleMediaRequest(
    get(mediaUrl(CID, PID), `${SESSION_COOKIE}=made.up`),
    signedIn.env,
  );
  check("a forged cookie is refused", forged?.status === 401, String(forged?.status));

  const ok = await handleMediaRequest(get(mediaUrl(CID, PID), signedIn.cookie), signedIn.env);
  check("a real session gets the photo", ok?.status === 200, String(ok?.status));
  check("content type replayed from storage", ok?.headers.get("content-type") === "image/webp");

  const thumb = await handleMediaRequest(get(mediaUrl(CID, PID, "t"), signedIn.cookie), signedIn.env);
  check("thumbnail served too", thumb?.status === 200);

  const missing = await handleMediaRequest(get(mediaUrl(CID, crypto.randomUUID()), signedIn.cookie), signedIn.env);
  check("unknown photo is a 404, not a 500", missing?.status === 404, String(missing?.status));

  const bad = await handleMediaRequest(get(`${MEDIA_PREFIX}/p/..%2F..%2Fmeta/x`, signedIn.cookie), signedIn.env);
  check("traversal attempt refused", bad === null || bad.status === 404, String(bad?.status));
}

console.log("\n=== 5. caching, so a scroll back costs nothing ===");
{
  const { env, cookie } = await envWith("member");
  const first = await handleMediaRequest(get(mediaUrl(CID, PID), cookie), env);
  const cacheControl = first?.headers.get("cache-control") ?? "";
  check("immutable", cacheControl.includes("immutable"));
  check("private, not shared", cacheControl.includes("private"));
  check("long lived", /max-age=\d{7,}/.test(cacheControl), cacheControl);

  const etag = first?.headers.get("etag") ?? "";
  check("etag present", etag.length > 0);

  const repeat = new Request(`https://gallery.test${mediaUrl(CID, PID)}`, {
    headers: { cookie, "if-none-match": etag },
  });
  const second = await handleMediaRequest(repeat, env);
  check("repeat view returns 304", second?.status === 304, String(second?.status));
  check("and sends no bytes", second?.body === null);
}

console.log("\n=== 6. uploading is an operator action ===");
{
  const upload = (cookie: string, body: BodyInit, type = "image/webp", qs = "") =>
    new Request(`https://gallery.test${MEDIA_PREFIX}/upload?collection=${CID}${qs}`, {
      method: "POST",
      headers: { cookie, "content-type": type, "x-file-name": "IMG_1.webp", "x-width": "2048", "x-height": "1365" },
      body,
    });

  const anon = await envWith(null);
  const r1 = await handleMediaRequest(upload("", "x"), anon.env);
  check("anonymous upload refused", r1?.status === 401, String(r1?.status));

  const member = await envWith("member");
  const r2 = await handleMediaRequest(upload(member.cookie, "x"), member.env);
  check("ordinary member refused", r2?.status === 403, String(r2?.status));

  const admin = await envWith("admin");
  const r3 = await handleMediaRequest(upload(admin.cookie, new Uint8Array([1, 2, 3, 4])), admin.env);
  check("admin accepted", r3?.status === 201, String(r3?.status));

  const created = (await r3!.json()) as { photoId: string; url: string; bytes: number };
  check("returns a photo id", isSafeId(created.photoId));
  check("returns a fetchable path", created.url.startsWith(`${MEDIA_PREFIX}/p/`));
  check("bytes stored", admin.bucket.store.has(photoKey(CID, created.photoId)));
  check("record written", admin.bucket.store.has(photoMetaKey(CID, created.photoId)));

  const meta = JSON.parse(admin.bucket.store.get(photoMetaKey(CID, created.photoId))!.body);
  check("filename kept", meta.fileName === "IMG_1.webp");
  check("dimensions kept", meta.width === 2048 && meta.height === 1365);
  check("uploader recorded", typeof meta.uploadedBy === "string" && meta.uploadedBy.length > 0);
}

console.log("\n=== 7. what an upload refuses ===");
{
  const admin = await envWith("admin");
  const post = (qs: string, type: string, body: BodyInit, extra: Record<string, string> = {}) =>
    new Request(`https://gallery.test${MEDIA_PREFIX}/upload?${qs}`, {
      method: "POST",
      headers: { cookie: admin.cookie, "content-type": type, ...extra },
      body,
    });

  const badCollection = await handleMediaRequest(post("collection=../evil", "image/webp", "x"), admin.env);
  check("bad collection id refused", badCollection?.status === 400, String(badCollection?.status));

  const badType = await handleMediaRequest(post(`collection=${CID}`, "application/pdf", "x"), admin.env);
  check("non-image refused", badType?.status === 415, String(badType?.status));

  const svg = await handleMediaRequest(post(`collection=${CID}`, "image/svg+xml", "x"), admin.env);
  check("svg refused, since it can carry script", svg?.status === 415, String(svg?.status));

  const empty = await handleMediaRequest(post(`collection=${CID}`, "image/webp", new Uint8Array()), admin.env);
  check("empty upload refused", empty?.status === 400, String(empty?.status));

  const huge = await handleMediaRequest(
    post(`collection=${CID}`, "image/webp", "x", { "content-length": String(MAX_UPLOAD_BYTES + 1) }),
    admin.env,
  );
  check("oversized refused", huge?.status === 413, String(huge?.status));

  const wrongMethod = await handleMediaRequest(
    new Request(`https://gallery.test${MEDIA_PREFIX}/upload?collection=${CID}`, {
      method: "GET",
      headers: { cookie: admin.cookie },
    }),
    admin.env,
  );
  check("GET on upload refused", wrongMethod?.status === 405, String(wrongMethod?.status));
}

console.log("\n=== 8. a thumbnail does not clobber its photo ===");
{
  const admin = await envWith("admin");
  const photoId = crypto.randomUUID();
  const send = (kind: string) =>
    new Request(
      `https://gallery.test${MEDIA_PREFIX}/upload?collection=${CID}&photo=${photoId}${kind}`,
      {
        method: "POST",
        headers: { cookie: admin.cookie, "content-type": "image/webp", "x-file-name": "A.webp", "x-width": "2048", "x-height": "1365" },
        body: new Uint8Array([1, 2, 3]),
      },
    );

  await handleMediaRequest(send(""), admin.env);
  const before = admin.bucket.store.get(photoMetaKey(CID, photoId))!.body;
  await handleMediaRequest(send("&kind=thumb"), admin.env);
  const after = admin.bucket.store.get(photoMetaKey(CID, photoId))!.body;

  check("thumbnail stored separately", admin.bucket.store.has(thumbKey(CID, photoId)));
  check("full image still there", admin.bucket.store.has(photoKey(CID, photoId)));
  check("record untouched by the thumbnail", before === after);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
