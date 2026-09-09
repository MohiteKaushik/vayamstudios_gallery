/**
 * Member accounts, stored in R2.
 *
 * Two objects per member, and the split matters:
 *
 *   meta/member/{id}      the record, including the password hash
 *   meta/email/{digest}   a pointer from email to id, for sign-in
 *
 * The email index is keyed by the SHA-256 of the address rather than the
 * address itself, so anyone who manages to list the bucket gets a pile of
 * digests instead of every client's email address.
 *
 * SIGN-UP RACES
 *
 * R2 has no transactions, so two people submitting the same address at the same
 * instant could both pass a "does this exist" check and both write. The index
 * is therefore written with a conditional put that only succeeds if nothing is
 * there, which makes the loser fail rather than silently overwrite the winner.
 * The record is written only after that claim succeeds, so a lost race leaves
 * nothing behind.
 */

import { emailKey, hashPassword, normaliseEmail, verifyPassword } from "./password.ts";
import type { R2Bucket } from "../storage.server.ts";

export type MemberRecord = {
  id: string;
  email: string;
  fullName: string;
  /** Ten digits, no country code. Empty for accounts created before it was collected. */
  phone: string;
  role: "admin" | "member";
  onboarded: boolean;
  /** Self-describing, so the cost can be raised later. Never leaves the server. */
  passwordHash: string;
  /** One or more face embeddings. Grows on its own as scans confirm new angles. */
  references: number[][];
  referenceImageKey: string | null;
  createdAt: number;
  lastSignInAt: number | null;
};

/** Everything except the password hash. This is the only shape that may reach a browser. */
export type PublicMember = Omit<MemberRecord, "passwordHash" | "references">;

export function toPublicMember(m: MemberRecord): PublicMember {
  const { passwordHash: _hash, references: _refs, ...rest } = m;
  return rest;
}

export const memberKey = (id: string) => `meta/member/${id}`;
export const emailIndexKey = (digest: string) => `meta/email/${digest}`;

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const obj = await bucket.get(key);
  if (!obj) return null;
  try {
    return await obj.json<T>();
  } catch {
    return null;
  }
}

export type SignUpInput = {
  email: string;
  password: string;
  fullName: string;
  phone: string;
  role?: "admin" | "member";
};

export type SignUpResult =
  | { ok: true; member: MemberRecord }
  | { ok: false; error: "email-taken" | "storage" };

/**
 * Creates an account, or reports that the address is already in use.
 *
 * The order is deliberate: claim the email first, write the record second. If
 * the claim fails there is nothing to clean up, and a record can never exist
 * that sign-in cannot find.
 */
export async function createMember(
  bucket: R2Bucket,
  input: SignUpInput,
): Promise<SignUpResult> {
  const email = normaliseEmail(input.email);
  const digest = await emailKey(email);
  const indexKey = emailIndexKey(digest);

  if (await bucket.head(indexKey)) return { ok: false, error: "email-taken" };

  const id = crypto.randomUUID();

  try {
    // Only succeeds if nothing is at this key, so a simultaneous sign-up with
    // the same address loses rather than overwriting.
    await bucket.put(indexKey, id, {
      httpMetadata: { contentType: "text/plain", cacheControl: "no-store" },
      onlyIf: { etagDoesNotMatch: "*" },
    });
  } catch {
    return { ok: false, error: "email-taken" };
  }

  // Re-read the claim. If another writer won, this returns their id, not ours,
  // and we must not proceed to write a record under an id nothing points to.
  const claimed = await bucket.get(indexKey);
  const claimedId = claimed ? (await claimed.text()).trim() : null;
  if (claimedId !== id) return { ok: false, error: "email-taken" };

  const member: MemberRecord = {
    id,
    email,
    fullName: input.fullName.trim(),
    phone: input.phone.replace(/\D/g, ""),
    role: input.role ?? "member",
    onboarded: false,
    passwordHash: await hashPassword(input.password),
    references: [],
    referenceImageKey: null,
    createdAt: Date.now(),
    lastSignInAt: null,
  };

  try {
    await bucket.put(memberKey(id), JSON.stringify(member), {
      httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
    });
  } catch {
    // Release the claim so the address is not permanently unusable.
    await bucket.delete(indexKey).catch(() => undefined);
    return { ok: false, error: "storage" };
  }

  return { ok: true, member };
}

export const getMemberById = (bucket: R2Bucket, id: string) =>
  readJson<MemberRecord>(bucket, memberKey(id));

export async function getMemberByEmail(
  bucket: R2Bucket,
  email: string,
): Promise<MemberRecord | null> {
  const object = await bucket.get(emailIndexKey(await emailKey(email)));
  if (!object) return null;
  const id = (await object.text()).trim();
  return id ? getMemberById(bucket, id) : null;
}

export async function putMember(bucket: R2Bucket, member: MemberRecord): Promise<void> {
  await bucket.put(memberKey(member.id), JSON.stringify(member), {
    httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
  });
}

/**
 * Checks an email and password pair.
 *
 * A missing account and a wrong password are the same answer on purpose. Saying
 * "no such user" tells a stranger which addresses are registered, which is a
 * list worth having if you are about to try passwords against it.
 *
 * A correct password on an outdated hash is re-hashed at the current cost
 * before returning, since this is the only moment the plaintext is in hand.
 */
export async function authenticate(
  bucket: R2Bucket,
  email: string,
  password: string,
): Promise<MemberRecord | null> {
  const member = await getMemberByEmail(bucket, email);
  if (!member) return null;

  const { valid, needsRehash } = await verifyPassword(password, member.passwordHash);
  if (!valid) return null;

  const updated: MemberRecord = {
    ...member,
    lastSignInAt: Date.now(),
    ...(needsRehash ? { passwordHash: await hashPassword(password) } : {}),
  };
  await putMember(bucket, updated).catch(() => undefined);
  return updated;
}

/**
 * Promotes the operator account on first sign-in.
 *
 * The console is reached by matching ADMIN_EMAIL rather than by anyone being
 * able to grant themselves a role, so this only records what is already true.
 */
export async function ensureRole(
  bucket: R2Bucket,
  member: MemberRecord,
  adminEmail: string | undefined,
): Promise<MemberRecord> {
  const shouldBeAdmin = !!adminEmail && member.email === normaliseEmail(adminEmail);
  const role: MemberRecord["role"] = shouldBeAdmin ? "admin" : "member";
  if (member.role === role) return member;
  const updated = { ...member, role };
  await putMember(bucket, updated).catch(() => undefined);
  return updated;
}
