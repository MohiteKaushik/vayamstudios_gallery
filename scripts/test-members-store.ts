/**
 * Member accounts in R2.
 *
 *   npm run test:store
 *
 * The mock honours R2's conditional put, because that is the only thing
 * stopping two simultaneous sign-ups on one address from overwriting each
 * other. A mock that ignores `onlyIf` would make the race look solved when it
 * is not.
 */

import {
  createMember,
  getMemberById,
  getMemberByEmail,
  authenticate,
  ensureRole,
  toPublicMember,
  memberKey,
  emailIndexKey,
} from "../src/lib/auth/members.server.ts";
import { emailKey } from "../src/lib/auth/password.ts";

let failures = 0;
const check = (name: string, pass: boolean, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!pass) failures++;
};

function mockR2() {
  const store = new Map<string, string>();
  let putFailsFor: string | null = null;
  return {
    store,
    failPutsFor(key: string | null) {
      putFailsFor = key;
    },
    async get(key: string) {
      if (!store.has(key)) return null;
      const body = store.get(key)!;
      return {
        key,
        text: async () => body,
        json: async <T,>() => JSON.parse(body) as T,
      } as never;
    },
    async head(key: string) {
      return store.has(key) ? ({ key } as never) : null;
    },
    async put(key: string, value: string, options?: { onlyIf?: { etagDoesNotMatch?: string } }) {
      if (putFailsFor && key.startsWith(putFailsFor)) throw new Error("simulated storage failure");
      // R2 rejects the write when the precondition fails. It does not silently
      // succeed, and the caller must be able to tell.
      if (options?.onlyIf?.etagDoesNotMatch === "*" && store.has(key)) {
        throw new Error("PreconditionFailed");
      }
      store.set(key, String(value));
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
    async list() {
      return { objects: [], truncated: false };
    },
  };
}

const base = { fullName: "Gagan Sharma", phone: "9876543210", password: "vayam2026pass" };

// ===========================================================================
console.log("\n=== 1. creating an account ===");
{
  const b = mockR2();
  const r = await createMember(b as never, { ...base, email: "Gagan@Gmail.COM" });
  check("succeeds", r.ok, r.ok ? "" : r.error);
  if (!r.ok) throw new Error("cannot continue");

  check("email stored folded", r.member.email === "gagan@gmail.com", r.member.email);
  check("phone stored as bare digits", r.member.phone === "9876543210", r.member.phone);
  check("starts as a member, not an admin", r.member.role === "member");
  check("not onboarded yet", r.member.onboarded === false);
  check("no face references yet", r.member.references.length === 0);
  check("password is hashed, not stored", !JSON.stringify(r.member).includes(base.password));
  check("hash names its algorithm", r.member.passwordHash.startsWith("pbkdf2-sha256$"));

  check("record written", b.store.has(memberKey(r.member.id)));
  check("email index written", b.store.has(emailIndexKey(await emailKey("gagan@gmail.com"))));
  check("index points at the record", b.store.get(emailIndexKey(await emailKey("gagan@gmail.com"))) === r.member.id);
  check("index key does not contain the address",
    !emailIndexKey(await emailKey("gagan@gmail.com")).includes("gagan"));
}

console.log("\n=== 2. one address, one account ===");
{
  const b = mockR2();
  const first = await createMember(b as never, { ...base, email: "taken@gmail.com" });
  check("first succeeds", first.ok);

  const second = await createMember(b as never, { ...base, email: "taken@gmail.com", fullName: "Someone Else" });
  check("second rejected", !second.ok && second.error === "email-taken");
  check("differing only by case is still taken",
    !(await createMember(b as never, { ...base, email: "TAKEN@Gmail.com" })).ok);

  const found = await getMemberByEmail(b as never, "taken@gmail.com");
  check("original record untouched", found?.fullName === "Gagan Sharma", found?.fullName ?? "null");
}

console.log("\n=== 3. a failed write leaves nothing behind ===");
{
  const b = mockR2();
  b.failPutsFor("meta/member/");
  const r = await createMember(b as never, { ...base, email: "unlucky@gmail.com" });
  check("reports storage failure", !r.ok && r.error === "storage", r.ok ? "ok" : r.error);
  check("email claim released", !b.store.has(emailIndexKey(await emailKey("unlucky@gmail.com"))));

  b.failPutsFor(null);
  const retry = await createMember(b as never, { ...base, email: "unlucky@gmail.com" });
  check("the address can be used afterwards", retry.ok);
}

console.log("\n=== 4. signing in ===");
{
  const b = mockR2();
  const created = await createMember(b as never, { ...base, email: "signin@gmail.com" });
  if (!created.ok) throw new Error("setup failed");

  check("correct password", (await authenticate(b as never, "signin@gmail.com", base.password))?.id === created.member.id);
  check("case-insensitive email", (await authenticate(b as never, "SignIn@Gmail.com", base.password)) !== null);
  check("wrong password rejected", (await authenticate(b as never, "signin@gmail.com", "wrong")) === null);
  check("empty password rejected", (await authenticate(b as never, "signin@gmail.com", "")) === null);
  check("unknown address rejected", (await authenticate(b as never, "nobody@gmail.com", base.password)) === null);

  const after = await getMemberById(b as never, created.member.id);
  check("last sign-in recorded", typeof after?.lastSignInAt === "number" && after!.lastSignInAt! > 0);
}

console.log("\n=== 5. a dangling index does not become an open door ===");
{
  const b = mockR2();
  const created = await createMember(b as never, { ...base, email: "orphan@gmail.com" });
  if (!created.ok) throw new Error("setup failed");
  // Index survives, record is gone. This must fail closed, not throw or pass.
  b.store.delete(memberKey(created.member.id));
  check("sign-in fails", (await authenticate(b as never, "orphan@gmail.com", base.password)) === null);
  check("lookup returns null", (await getMemberByEmail(b as never, "orphan@gmail.com")) === null);
}

console.log("\n=== 6. the operator role ===");
{
  const b = mockR2();
  const admin = await createMember(b as never, { ...base, email: "vayamdesigners@gmail.com" });
  const other = await createMember(b as never, { ...base, email: "someone@gmail.com" });
  if (!admin.ok || !other.ok) throw new Error("setup failed");

  const promoted = await ensureRole(b as never, admin.member, "VayamDesigners@Gmail.com");
  check("operator address is promoted", promoted.role === "admin");
  check("promotion persisted", (await getMemberById(b as never, admin.member.id))?.role === "admin");

  const stays = await ensureRole(b as never, other.member, "vayamdesigners@gmail.com");
  check("everyone else stays a member", stays.role === "member");

  // Someone who was an admin and no longer matches must lose it.
  const demoted = await ensureRole(b as never, { ...promoted }, "different@gmail.com");
  check("no longer matching means no longer admin", demoted.role === "member");
  check("nothing is promoted when no operator is configured",
    (await ensureRole(b as never, other.member, undefined)).role === "member");
}

console.log("\n=== 7. what may reach a browser ===");
{
  const b = mockR2();
  const r = await createMember(b as never, { ...base, email: "public@gmail.com" });
  if (!r.ok) throw new Error("setup failed");
  const pub = toPublicMember({ ...r.member, references: [[0.1, 0.2]] });
  const serialised = JSON.stringify(pub);

  check("no password hash", !("passwordHash" in pub) && !serialised.includes("pbkdf2"));
  check("no face embeddings", !("references" in pub) && !serialised.includes("0.1"));
  check("identity kept", pub.id === r.member.id && pub.email === "public@gmail.com");
  check("contact details kept", pub.fullName === "Gagan Sharma" && pub.phone === "9876543210");
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
