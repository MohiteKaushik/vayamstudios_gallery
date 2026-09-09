/**
 * Password hashing and session tokens.
 *
 *   npm run test:auth
 *
 * These run on the same WebCrypto the Workers runtime provides, so what passes
 * here is what will run in production. Most checks are about the failure side:
 * a wrong password, a forged signature, an expired token, a corrupted record.
 * Getting any of those to return "yes" is the whole risk in an auth layer.
 */

import {
  hashPassword,
  verifyPassword,
  timingSafeEqual,
  normaliseEmail,
  emailKey,
  DEFAULT_ITERATIONS,
} from "../src/lib/auth/password.ts";
import {
  createSessionToken,
  verifySessionToken,
  sessionCookieHeader,
  clearSessionCookieHeader,
  readCookie,
  isSecureRequest,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from "../src/lib/auth/session.ts";

let failures = 0;
const check = (name: string, pass: boolean, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!pass) failures++;
};

// Fast cost for the behavioural checks; the real cost is measured once, below.
const FAST = 1000;
const SECRET = "a-test-secret-that-is-long-enough-to-be-realistic";

// ===========================================================================
console.log("\n=== 1. password hashing ===");
{
  const stored = await hashPassword("correct horse battery staple", FAST);
  const parts = stored.split("$");
  check("four fields", parts.length === 4, `${parts.length}`);
  check("names its algorithm", parts[0] === "pbkdf2-sha256", parts[0]);
  check("records its cost", Number(parts[1]) === FAST, parts[1]);
  check("hash is not the password", !stored.includes("correct horse"));

  const again = await hashPassword("correct horse battery staple", FAST);
  check("same password hashes differently each time", stored !== again, "salt is random");
}

console.log("\n=== 2. verifying ===");
{
  const stored = await hashPassword("s3cret-pass", FAST);
  check("correct password passes", (await verifyPassword("s3cret-pass", stored, FAST)).valid);
  check("wrong password fails", !(await verifyPassword("s3cret-pasS", stored, FAST)).valid);
  check("empty password fails", !(await verifyPassword("", stored, FAST)).valid);
  check("near-miss fails", !(await verifyPassword("s3cret-pass ", stored, FAST)).valid);
}

console.log("\n=== 3. a broken record is never a free pass ===");
{
  const cases: [string, string][] = [
    ["empty string", ""],
    ["no separators", "garbage"],
    ["too few fields", "pbkdf2-sha256$1000$onlythree"],
    ["unknown algorithm", "bcrypt$10$abc$def"],
    ["non-numeric cost", "pbkdf2-sha256$abc$c2FsdA$aGFzaA"],
    ["zero cost", "pbkdf2-sha256$0$c2FsdA$aGFzaA"],
    ["negative cost", "pbkdf2-sha256$-5$c2FsdA$aGFzaA"],
    ["empty salt", "pbkdf2-sha256$1000$$aGFzaA"],
    ["empty hash", "pbkdf2-sha256$1000$c2FsdA$"],
  ];
  for (const [name, stored] of cases) {
    const r = await verifyPassword("anything", stored, FAST);
    check(name + " rejected", !r.valid);
  }
}

console.log("\n=== 4. cost can be raised without locking anyone out ===");
{
  const old = await hashPassword("legacy-password", 1000);
  const r = await verifyPassword("legacy-password", old, 5000);
  check("an old hash still verifies", r.valid);
  check("and is flagged for re-hashing", r.needsRehash);

  const current = await hashPassword("legacy-password", 5000);
  const r2 = await verifyPassword("legacy-password", current, 5000);
  check("a current hash is not flagged", r2.valid && !r2.needsRehash);
  check("a wrong password is never flagged", !(await verifyPassword("nope", old, 5000)).needsRehash);
}

console.log("\n=== 5. constant-time compare ===");
{
  const a = new Uint8Array([1, 2, 3, 4]);
  check("equal arrays match", timingSafeEqual(a, new Uint8Array([1, 2, 3, 4])));
  check("first byte differing fails", !timingSafeEqual(a, new Uint8Array([9, 2, 3, 4])));
  check("last byte differing fails", !timingSafeEqual(a, new Uint8Array([1, 2, 3, 9])));
  check("shorter fails", !timingSafeEqual(a, new Uint8Array([1, 2, 3])));
  check("longer fails", !timingSafeEqual(a, new Uint8Array([1, 2, 3, 4, 5])));
  check("empty pair matches", timingSafeEqual(new Uint8Array(), new Uint8Array()));
}

console.log("\n=== 6. email handling ===");
{
  check("case folded", normaliseEmail("  Gagan@Gmail.COM ") === "gagan@gmail.com");
  const a = await emailKey("gagan@gmail.com");
  const b = await emailKey("GAGAN@GMAIL.COM  ");
  check("same account whatever the casing", a === b);
  check("different accounts differ", a !== (await emailKey("other@gmail.com")));
  check("key does not contain the address", !a.includes("gagan"), a.slice(0, 12) + "...");
  check("key is url-safe", /^[A-Za-z0-9_-]+$/.test(a));
}

// ===========================================================================
console.log("\n=== 7. session tokens ===");
{
  const token = await createSessionToken("user-123", SECRET);
  const claims = await verifySessionToken(token, SECRET);
  check("round-trips", claims?.sub === "user-123", claims?.sub ?? "null");
  check("carries an expiry", typeof claims?.exp === "number" && claims!.exp > claims!.iat);
  check("expiry matches the ttl", claims!.exp - claims!.iat === SESSION_TTL_SECONDS);
}

console.log("\n=== 8. forgery ===");
{
  const token = await createSessionToken("user-123", SECRET);
  const [payload, sig] = token.split(".");

  check("wrong secret rejected", (await verifySessionToken(token, "different-secret")) === null);

  // Re-sign a different user with a made-up key: the classic escalation attempt.
  const forgedPayload = btoa(JSON.stringify({ sub: "admin", iat: 0, exp: 9999999999 }))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  check("payload swapped, old signature rejected",
    (await verifySessionToken(`${forgedPayload}.${sig}`, SECRET)) === null);

  check("signature altered rejected",
    (await verifySessionToken(`${payload}.${sig!.slice(0, -2)}AA`, SECRET)) === null);
  check("signature removed rejected", (await verifySessionToken(payload!, SECRET)) === null);
  check("empty token rejected", (await verifySessionToken("", SECRET)) === null);
  check("null token rejected", (await verifySessionToken(null, SECRET)) === null);
  check("dot only rejected", (await verifySessionToken(".", SECRET)) === null);
  check("no secret rejected", (await verifySessionToken(token, "")) === null);
  check("garbage rejected", (await verifySessionToken("not-a-token", SECRET)) === null);
}

console.log("\n=== 9. expiry ===");
{
  const now = 1_000_000;
  const token = await createSessionToken("user-123", SECRET, 60, now);
  check("valid inside the window", (await verifySessionToken(token, SECRET, now + 30))?.sub === "user-123");
  check("rejected at the boundary", (await verifySessionToken(token, SECRET, now + 60)) === null);
  check("rejected after it", (await verifySessionToken(token, SECRET, now + 61)) === null);
  check("a valid signature does not save an expired token",
    (await verifySessionToken(token, SECRET, now + 100000)) === null);
}

console.log("\n=== 10. the cookie ===");
{
  const header = sessionCookieHeader("abc.def");
  check("HttpOnly, so scripts cannot read it", header.includes("HttpOnly"));
  check("Secure, so it never crosses plain http", header.includes("Secure"));
  check("SameSite=Lax, so other sites cannot use it", header.includes("SameSite=Lax"));
  check("scoped to the whole site", header.includes("Path=/"));
  check("has a max age", /Max-Age=\d+/.test(header));
  check("named consistently", header.startsWith(`${SESSION_COOKIE}=`));

  check("Secure can be dropped for local http only",
    !sessionCookieHeader("abc.def", { secure: false }).includes("Secure"));

  const cleared = clearSessionCookieHeader();
  check("sign-out expires it immediately", cleared.includes("Max-Age=0"));
  check("sign-out sends no value", cleared.startsWith(`${SESSION_COOKIE}=;`));
}

console.log("\n=== 11. reading the cookie back ===");
{
  const req = (cookie: string) => new Request("https://x/", { headers: { cookie } });
  check("single cookie", readCookie(req(`${SESSION_COOKIE}=tok123`)) === "tok123");
  check("among others", readCookie(req(`theme=dark; ${SESSION_COOKIE}=tok123; other=1`)) === "tok123");
  check("with spaces", readCookie(req(` ${SESSION_COOKIE} = tok123 `)) === "tok123");
  check("absent gives null", readCookie(req("theme=dark")) === null);
  check("no header gives null", readCookie(new Request("https://x/")) === null);
  check("a prefix match is not a match", readCookie(req("not_vayam_session=x")) === null);

  check("https marked secure", isSecureRequest(new Request("https://x/")));
  check("http not marked secure", !isSecureRequest(new Request("http://localhost:5173/")));
}

// ===========================================================================
console.log("\n=== 12. what the real cost actually is ===");
{
  const t0 = Date.now();
  const stored = await hashPassword("a-realistic-password", DEFAULT_ITERATIONS);
  const hashMs = Date.now() - t0;
  const t1 = Date.now();
  const r = await verifyPassword("a-realistic-password", stored, DEFAULT_ITERATIONS);
  const verifyMs = Date.now() - t1;

  console.log(`    ${DEFAULT_ITERATIONS.toLocaleString()} iterations: ${hashMs}ms to hash, ${verifyMs}ms to verify`);
  console.log(`    Workers Paid includes 30 million CPU-ms a month, so roughly ${Math.floor(30_000_000 / Math.max(1, verifyMs)).toLocaleString()} sign-ins are covered.`);
  check("the default cost verifies correctly", r.valid);
  check("sign-in stays under a second", verifyMs < 1000, `${verifyMs}ms`);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
