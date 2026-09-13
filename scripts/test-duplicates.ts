/**
 * Duplicate detection.
 *
 *   npm run test:duplicates
 *
 * Built from real photographs edited the ways an upload mistake edits them:
 * the same file twice, re-saved at a lower quality, resized, brightened,
 * lightly cropped. Each is reduced to a thumbnail first, exactly as the console
 * sees it. The other half of the checks is the one that matters more: that
 * genuinely different photographs are never offered up as copies.
 */

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  LEVELS,
  compare,
  decodeFingerprint,
  encodeFingerprint,
  findDuplicateGroups,
  fingerprintPixels,
  hamming,
  isFingerprint,
  passes,
  type DuplicateCandidate,
} from "../src/lib/duplicates.ts";

let failures = 0;
const check = (name: string, pass: boolean, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!pass) failures++;
};

const DIR = "C:/Users/mohit/OneDrive/Documents/my files/projects/Vayam/TTPOC event photos";
const sources = fs.existsSync(DIR)
  ? fs.readdirSync(DIR).filter((f) => /\.(png|jpe?g)$/i.test(f)).slice(0, 4).map((f) => path.join(DIR, f))
  : [];

/** What the console reads: the 512 pixel thumbnail, then its 64x64 copy. */
async function fingerprintOf(image: Buffer) {
  const thumb = await sharp(image).resize(512, 512, { fit: "inside" }).jpeg({ quality: 80 }).toBuffer();
  const meta = await sharp(thumb).metadata();
  const raw = await sharp(thumb).resize(64, 64, { fit: "fill" }).ensureAlpha().raw().toBuffer();
  return { fingerprint: fingerprintPixels(new Uint8Array(raw)), width: meta.width!, height: meta.height! };
}

const asItem = (f: { fingerprint: string; width: number; height: number }) => ({
  fp: decodeFingerprint(f.fingerprint)!,
  width: f.width,
  height: f.height,
});

// ===========================================================================
console.log("\n=== 1. the fingerprint itself ===");
{
  const fp = { d: [0xdeadbeef, 0x01234567] as [number, number], p: [0, 0xffffffff] as [number, number], colour: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 255]) };
  const text = encodeFingerprint(fp);
  const back = decodeFingerprint(text)!;
  check("encodes to 56 hex characters", text.length === 56 && isFingerprint(text), text);
  check("decodes back unchanged", back.d[0] === fp.d[0] && back.p[1] === fp.p[1] && back.colour[11] === 255);
  check("junk is not a fingerprint", !isFingerprint("zz") && !isFingerprint("0".repeat(55)) && decodeFingerprint("nope") === null);
  check("identical hashes are 0 apart", hamming([5, 9], [5, 9]) === 0);
  check("every bit different is 64 apart", hamming([0, 0], [0xffffffff, 0xffffffff]) === 64);
  check("one bit is 1 apart", hamming([0, 0], [0, 1]) === 1);
}

if (sources.length < 4) {
  console.log("\n(the four test photographs were not found; skipping the photograph checks)");
} else {
  const originals = await Promise.all(sources.map((s) => sharp(s).resize(1600, 1600, { fit: "inside" }).jpeg({ quality: 92 }).toBuffer()));
  const [a, b, c, d] = originals as [Buffer, Buffer, Buffer, Buffer];
  const fa = await fingerprintOf(a);

  // =========================================================================
  console.log("\n=== 2. the same photograph, uploaded again ===");
  {
    const cases: [string, Buffer][] = [
      ["the same file twice", a],
      ["re-saved at quality 50", await sharp(a).jpeg({ quality: 50 }).toBuffer()],
      ["resized to half", await sharp(a).resize(800).jpeg({ quality: 85 }).toBuffer()],
      ["converted to PNG", await sharp(a).png().toBuffer()],
    ];
    for (const [name, image] of cases) {
      const cmp = compare(asItem(fa), asItem(await fingerprintOf(image)));
      check(`${name} is an exact copy`, passes(cmp, LEVELS.exact), `d${cmp.dHash} p${cmp.pHash} c${cmp.colour.toFixed(1)}`);
    }
  }

  // =========================================================================
  console.log("\n=== 3. near-identical frames ===");
  {
    const meta = await sharp(a).metadata();
    const w = meta.width!, h = meta.height!;
    const cases: [string, Buffer][] = [
      ["brightened 12%", await sharp(a).modulate({ brightness: 1.12 }).jpeg().toBuffer()],
      ["cropped 3% on every side", await sharp(a).extract({ left: Math.round(w * 0.03), top: Math.round(h * 0.03), width: Math.round(w * 0.94), height: Math.round(h * 0.94) }).jpeg().toBuffer()],
    ];
    for (const [name, image] of cases) {
      const cmp = compare(asItem(fa), asItem(await fingerprintOf(image)));
      check(`${name} is found as similar`, passes(cmp, LEVELS.similar), `d${cmp.dHash} p${cmp.pHash} c${cmp.colour.toFixed(1)}`);
    }
    const mirrored = compare(asItem(fa), asItem(await fingerprintOf(await sharp(a).flop().jpeg().toBuffer())));
    check("a mirrored photo is not an exact copy", !passes(mirrored, LEVELS.exact), `d${mirrored.dHash} p${mirrored.pHash}`);
  }

  // =========================================================================
  console.log("\n=== 4. different photographs are never duplicates ===");
  {
    const all = [a, b, c, d];
    const fps = await Promise.all(all.map(fingerprintOf));
    let worst = { dHash: 64, pHash: 64 };
    let anyPass = false;
    for (let i = 0; i < fps.length; i++) {
      for (let j = i + 1; j < fps.length; j++) {
        const cmp = compare(asItem(fps[i]!), asItem(fps[j]!));
        if (passes(cmp, LEVELS.similar)) anyPass = true;
        if (cmp.pHash < worst.pHash) worst = cmp;
      }
    }
    check("no two different photographs pass even the looser level", !anyPass, `closest pair d${worst.dHash} p${worst.pHash}`);
  }

  // =========================================================================
  console.log("\n=== 5. grouping ===");
  {
    const now = Date.now();
    const make = async (id: string, image: Buffer, createdAt: number): Promise<DuplicateCandidate> => {
      const f = await fingerprintOf(image);
      const m = await sharp(image).metadata();
      return { id, fingerprint: f.fingerprint, width: m.width!, height: m.height!, createdAt };
    };
    const items = [
      await make("a-small", await sharp(a).resize(700).jpeg().toBuffer(), now - 5000),
      await make("a-original", a, now),
      await make("a-resaved", await sharp(a).jpeg({ quality: 55 }).toBuffer(), now + 1000),
      await make("b", b, now),
      await make("b-again", b, now + 2000),
      await make("c", c, now),
    ];
    const groups = findDuplicateGroups(items, LEVELS.exact);
    const ga = groups.find((g) => g.keep.startsWith("a"));
    const gb = groups.find((g) => g.keep.startsWith("b"));
    check("two groups: one per photograph uploaded more than once", groups.length === 2, `${groups.length}`);
    check("the largest copy is the one kept", ga?.keep === "a-original", ga?.keep);
    check("both other copies of it are offered", ga?.copies.length === 2);
    check("with equal size, the earliest upload is kept", gb?.keep === "b" && gb?.copies[0]?.id === "b-again");
    check("a photograph uploaded once is left alone", !groups.some((g) => g.keep === "c" || g.copies.some((x) => x.id === "c")));
    check("copies found at this level are marked exact", ga!.copies.every((x) => x.exact));
  }
}

// ===========================================================================
console.log("\n=== 6. no chains ===");
{
  // X and Y are near, Y and Z are near, X and Z are not. Linking pairs would
  // put all three together and offer Z for deletion against X.
  const base = "0".repeat(16);
  const flip = (bits: number) => {
    let lo = 0;
    for (let i = 0; i < bits; i++) lo |= 1 << i;
    return (lo >>> 0).toString(16).padStart(8, "0");
  };
  const colour = "808080".repeat(4);
  const fpX = base + "00000000" + "00000000" + colour;
  const fpY = base + "00000000" + flip(10) + colour; // 10 bits from X
  const fpZ = base + "ffff0000" + flip(10) + colour; // 16 more bits from Y, 26 from X
  const items: DuplicateCandidate[] = [
    { id: "X", fingerprint: fpX, width: 2000, height: 1000, createdAt: 1 },
    { id: "Y", fingerprint: fpY, width: 1000, height: 500, createdAt: 2 },
    { id: "Z", fingerprint: fpZ, width: 1000, height: 500, createdAt: 3 },
  ];
  const groups = findDuplicateGroups(items, { ...LEVELS.similar, pHash: 16 });
  check("Y joins X", groups[0]?.keep === "X" && groups[0]?.copies.some((c) => c.id === "Y"));
  check("Z does not join X through Y", !groups.some((g) => g.keep === "X" && g.copies.some((c) => c.id === "Z")));
}

// ===========================================================================
console.log("\n=== 7. speed ===");
{
  const n = 3000;
  const items: DuplicateCandidate[] = Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    fingerprint: Array.from({ length: 56 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join(""),
    width: 2048,
    height: 1365,
    createdAt: i,
  }));
  const t = Date.now();
  findDuplicateGroups(items, LEVELS.similar);
  const ms = Date.now() - t;
  check(`${n} photographs are grouped in under two seconds`, ms < 2000, `${ms}ms`);
}

// ===========================================================================
console.log("\n=== 8. saving fingerprints through the API ===");
{
  const { handleApiRequest } = await import("../src/lib/api.server.ts");
  const { createMember } = await import("../src/lib/auth/members.server.ts");
  const { createSessionToken, sessionCookieHeader } = await import("../src/lib/auth/session.ts");

  const store = new Map<string, string>();
  const obj = (key: string, body: string) => ({
    key, size: body.length, etag: "e", httpEtag: '"e"', uploaded: new Date(), body: body as never,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    text: async () => body,
    json: async <T,>() => JSON.parse(body) as T,
    writeHttpMetadata: () => {},
  });
  const bucket = {
    async get(k: string) { const b = store.get(k); return b === undefined ? null : obj(k, b); },
    async head(k: string) { const b = store.get(k); return b === undefined ? null : obj(k, b); },
    async put(k: string, v: unknown) { store.set(k, String(v)); },
    async delete(keys: string | string[]) { for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k); },
    async list(o: { prefix?: string; cursor?: string; limit?: number } = {}) {
      const all = [...store.keys()].filter((k) => k.startsWith(o.prefix ?? "")).sort();
      const start = o.cursor ? Number(o.cursor) : 0;
      const limit = o.limit ?? 1000;
      const truncated = start + limit < all.length;
      return { objects: all.slice(start, start + limit).map((key) => ({ key })), truncated, ...(truncated ? { cursor: String(start + limit) } : {}) };
    },
  };
  const SECRET = "test-session-secret-long-enough-for-hmac";
  const env = { PHOTOS: bucket as never, SESSION_SECRET: SECRET };

  const cookieFor = async (role: "admin" | "member") => {
    const created = await createMember(bucket as never, {
      email: `${role}@dup.test`, password: "password2026", fullName: "Test", phone: "9876543210", role,
    });
    if (!created.ok) throw new Error("could not create the test account");
    return sessionCookieHeader(await createSessionToken(created.member.id, SECRET)).split(";")[0]!;
  };

  const cid = crypto.randomUUID();
  const p1 = crypto.randomUUID();
  const p2 = crypto.randomUUID();
  store.set(`meta/collection/${cid}`, JSON.stringify({ id: cid, name: "Event", createdAt: 1 }));
  for (const [i, id] of [p1, p2].entries()) {
    store.set(`meta/photo/${cid}/${id}`, JSON.stringify({ id, collectionId: cid, fileName: `IMG_${i}.jpg`, width: 800, height: 600, facesCount: 0, createdAt: i }));
  }
  const good = "0123456789abcdef".repeat(3) + "01234567";

  const send = async (cookie: string, body: unknown) => {
    const res = await handleApiRequest(
      new Request(`https://gallery.test/api/collections/${cid}/fingerprints`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      env as never,
    );
    return { status: res!.status, data: (await res!.json()) as { saved?: number } };
  };

  const member = await send(await cookieFor("member"), { items: [{ photoId: p1, fingerprint: good }] });
  check("a member cannot store fingerprints", member.status === 403, `${member.status}`);

  const admin = await cookieFor("admin");
  const saved = await send(admin, {
    items: [
      { photoId: p1, fingerprint: good },
      { photoId: p2, fingerprint: good },
      { photoId: "../../meta/member/x", fingerprint: good },
      { photoId: crypto.randomUUID(), fingerprint: good },
      { photoId: p1, fingerprint: "not-a-fingerprint" },
    ],
  });
  check("only real photos with valid fingerprints are saved", saved.status === 200 && saved.data.saved === 2, JSON.stringify(saved.data));
  const record = JSON.parse(store.get(`meta/photo/${cid}/${p1}`)!);
  check("the fingerprint is stored on the photo", record.fingerprint === good);
  check("and nothing else about the photo changes", record.fileName === "IMG_0.jpg" && record.width === 800);

  const listed = await handleApiRequest(
    new Request(`https://gallery.test/api/collections/${cid}/photos`, { headers: { cookie: admin } }),
    env as never,
  );
  const photos = ((await listed!.json()) as { photos: { id: string; fingerprint: string | null }[] }).photos;
  check("the photo listing returns fingerprints", photos.length === 2 && photos.every((p) => p.fingerprint === good));

  console.log("\n=== 9. the home cover ===");
  const coverCall = async (cookie: string, method: string, body?: unknown) => {
    const res = await handleApiRequest(
      new Request("https://gallery.test/api/site/cover", {
        method,
        headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      env as never,
    );
    return { status: res!.status, data: (await res!.json()) as { coverUrl?: string | null } };
  };
  const viewer = await createMember(bucket as never, {
    email: "viewer@dup.test", password: "password2026", fullName: "Viewer", phone: "9876543211", role: "member",
  });
  if (!viewer.ok) throw new Error("could not create the viewer account");
  const viewerCookie = sessionCookieHeader(await createSessionToken(viewer.member.id, SECRET)).split(";")[0]!;

  const empty = await coverCall(viewerCookie, "GET");
  check("with no cover chosen, members get none", empty.status === 200 && empty.data.coverUrl === null);
  const denied = await coverCall(viewerCookie, "PUT", { collectionId: cid, photoId: p1 });
  check("a member cannot choose the cover", denied.status === 403, `${denied.status}`);
  const badId = await coverCall(admin, "PUT", { collectionId: cid, photoId: "../../meta/member/x" });
  check("an unsafe id is refused", badId.status === 400, `${badId.status}`);
  const missing = await coverCall(admin, "PUT", { collectionId: cid, photoId: crypto.randomUUID() });
  check("a photo that does not exist is refused", missing.status === 404, `${missing.status}`);
  const set = await coverCall(admin, "PUT", { collectionId: cid, photoId: p1 });
  check("an admin can choose a photo as the cover", set.status === 200 && set.data.coverUrl === `/media/t/${cid}/${p1}`, JSON.stringify(set.data));
  const seen = await coverCall(viewerCookie, "GET");
  check("members then see that cover", seen.data.coverUrl === `/media/t/${cid}/${p1}`);
  const eventRecord = store.get(`meta/collection/${cid}`)!;
  store.delete(`meta/collection/${cid}`);
  const binned = await coverCall(viewerCookie, "GET");
  check("an event in the recycle bin shows no cover", binned.data.coverUrl === null);
  store.set(`meta/collection/${cid}`, eventRecord);
  const cleared = await coverCall(admin, "DELETE");
  const after = await coverCall(viewerCookie, "GET");
  check("an admin can remove the cover", cleared.status === 200 && after.data.coverUrl === null);

  console.log("\n=== 10. renaming past events ===");
  const pastCall = async (cookie: string, method: string, body?: unknown) => {
    const res = await handleApiRequest(
      new Request("https://gallery.test/api/site/past-events", {
        method,
        headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      env as never,
    );
    return { status: res!.status, data: (await res!.json()) as { renames?: Record<string, string> } };
  };
  const none = await pastCall(viewerCookie, "GET");
  check("with no renames, members get the original list", none.status === 200 && Object.keys(none.data.renames ?? {}).length === 0);
  const memberRename = await pastCall(viewerCookie, "PUT", { id: "conyape-retreat", title: "Hijack" });
  check("a member cannot rename a past event", memberRename.status === 403, `${memberRename.status}`);
  const unknown = await pastCall(admin, "PUT", { id: "not-an-event", title: "Anything" });
  check("an unknown event is refused", unknown.status === 404, `${unknown.status}`);
  const blank = await pastCall(admin, "PUT", { id: "conyape-retreat", title: "  " });
  check("an empty name is refused", blank.status === 400, `${blank.status}`);
  const renamed = await pastCall(admin, "PUT", { id: "conyape-retreat", title: "  The   Conyape Retreat 2025 " });
  check("an admin can rename, with spaces tidied", renamed.status === 200 && renamed.data.renames?.["conyape-retreat"] === "The Conyape Retreat 2025", JSON.stringify(renamed.data));
  const memberSees = await pastCall(viewerCookie, "GET");
  check("members then see the new name", memberSees.data.renames?.["conyape-retreat"] === "The Conyape Retreat 2025");
  const reverted = await pastCall(admin, "PUT", { id: "conyape-retreat", title: "The Conyape Retreat" });
  check("saving the original name removes the rename", reverted.status === 200 && !("conyape-retreat" in (reverted.data.renames ?? {})));
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
