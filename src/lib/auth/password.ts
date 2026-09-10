/**
 * Password hashing, using only what the Workers runtime already provides.
 *
 * PBKDF2-HMAC-SHA256 through WebCrypto. No native module, no dependency, and
 * nothing to install, which matters because a Worker cannot load bcrypt or
 * argon2 the way a Node server would.
 *
 * The stored string carries its own parameters:
 *
 *   pbkdf2-sha256$600000$<salt>$<hash>
 *
 * That is deliberate. Iteration counts have to rise as hardware gets faster,
 * and a hash that says how it was made can be verified with its original cost
 * and quietly re-hashed at the new one on the next successful sign-in. A bare
 * hash with the cost hardcoded elsewhere can never be upgraded without locking
 * everyone out.
 */

/**
 * The Workers runtime refuses more than this:
 *
 *   Pbkdf2 failed: iteration counts above 100000 are not supported
 *   (requested 600000)
 *
 * Node has no such cap, so a higher value passes every test in this repository
 * and then fails on the first real sign-in in production. Anything derived from
 * this constant must stay at or below it.
 */
export const MAX_WORKERS_ITERATIONS = 100_000;

/**
 * Iterations used when hashing a new password.
 *
 * OWASP asks for 600,000 for PBKDF2-HMAC-SHA256 and the platform allows a sixth
 * of that, so this sits at the ceiling rather than at the recommendation. Worth
 * being straight about: that is weaker than the guidance against an attacker who
 * has already stolen the stored hashes. Every hash still carries its own random
 * 16-byte salt, so precomputed tables are useless and each password has to be
 * attacked on its own.
 *
 * The stored format records its own cost, so if the runtime ever lifts the cap
 * this can be raised and existing hashes upgrade quietly on the next sign-in.
 */
export const DEFAULT_ITERATIONS = MAX_WORKERS_ITERATIONS;

const ALGORITHM = "pbkdf2-sha256";
const SALT_BYTES = 16;
const HASH_BITS = 256;

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    keyMaterial,
    HASH_BITS,
  );
  return new Uint8Array(bits);
}

/**
 * Compares two byte arrays in time that does not depend on where they differ.
 *
 * A normal comparison returns early on the first mismatch, and the timing of
 * that leaks how much of a guess was correct, one byte at a time.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Hashes a password for storage. Never store, log or return the input. */
export async function hashPassword(
  password: string,
  iterations = DEFAULT_ITERATIONS,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, iterations);
  return `${ALGORITHM}$${iterations}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

export type VerifyResult = {
  valid: boolean;
  /** True when the stored hash used a weaker cost than we now require. */
  needsRehash: boolean;
};

/**
 * Checks a password against a stored hash.
 *
 * A malformed or unknown stored value is a failure, never a pass. Getting that
 * backwards is how an empty or corrupted record turns into an open door.
 */
export async function verifyPassword(
  password: string,
  stored: string,
  minimumIterations = DEFAULT_ITERATIONS,
): Promise<VerifyResult> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== ALGORITHM) return { valid: false, needsRehash: false };

  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1) return { valid: false, needsRehash: false };

  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = fromBase64Url(parts[2]!);
    expected = fromBase64Url(parts[3]!);
  } catch {
    return { valid: false, needsRehash: false };
  }
  if (salt.length === 0 || expected.length === 0) return { valid: false, needsRehash: false };

  const actual = await derive(password, salt, iterations);
  const valid = timingSafeEqual(actual, expected);
  return { valid, needsRehash: valid && iterations < minimumIterations };
}

/** Normalises an email for storage and lookup, so casing never splits an account. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The R2 key an account is found by at sign-in.
 *
 * Hashed rather than stored in the clear so that a listing of the bucket does
 * not hand over every member's email address.
 */
export async function emailKey(email: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(normaliseEmail(email)));
  return toBase64Url(new Uint8Array(digest));
}
