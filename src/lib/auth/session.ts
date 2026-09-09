/**
 * Sessions, as a signed cookie rather than a row in a database.
 *
 * A session token here is a small payload plus an HMAC over it. Verifying one
 * is pure computation, so an authenticated request costs nothing in storage
 * reads. At two hundred members browsing a gallery, that is the difference
 * between a lookup on every photo request and none at all.
 *
 * The trade is revocation. Nothing can invalidate an issued token before it
 * expires, so lifetimes are kept short enough that it matters little, and
 * anything genuinely destructive should re-check the account rather than trust
 * the cookie alone.
 *
 * The cookie itself is HttpOnly, so page scripts cannot read it and an injected
 * script cannot steal a session; Secure, so it never crosses plain HTTP; and
 * SameSite=Lax, so another site cannot silently act as the member.
 */

import { timingSafeEqual } from "./password.ts";

export const SESSION_COOKIE = "vayam_session";

/** Seven days. Long enough not to nag, short enough to bound a stolen cookie. */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return toBase64Url(new Uint8Array(sig));
}

export type SessionClaims = {
  /** The member this session belongs to. */
  sub: string;
  /** Seconds since epoch at which the token stops being accepted. */
  exp: number;
  /** Seconds since epoch at which it was issued. */
  iat: number;
};

/** Issues a signed session token for a member. */
export async function createSessionToken(
  userId: string,
  secret: string,
  ttlSeconds = SESSION_TTL_SECONDS,
  now = Math.floor(Date.now() / 1000),
): Promise<string> {
  if (!secret) throw new Error("SESSION_SECRET is not set");
  const claims: SessionClaims = { sub: userId, iat: now, exp: now + ttlSeconds };
  const payload = toBase64Url(encoder.encode(JSON.stringify(claims)));
  return `${payload}.${await sign(payload, secret)}`;
}

/**
 * Verifies a token and returns its claims, or null.
 *
 * The signature is checked before the payload is trusted for anything, and an
 * expired token fails even though its signature is perfectly valid.
 */
export async function verifySessionToken(
  token: string | null | undefined,
  secret: string,
  now = Math.floor(Date.now() / 1000),
): Promise<SessionClaims | null> {
  if (!token || !secret) return null;

  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payload = token.slice(0, dot);
  const provided = token.slice(dot + 1);

  let expectedSig: string;
  try {
    expectedSig = await sign(payload, secret);
  } catch {
    return null;
  }

  // Compare as bytes, in constant time. A string compare would leak how much of
  // a forged signature was right.
  let ok: boolean;
  try {
    ok = timingSafeEqual(fromBase64Url(provided), fromBase64Url(expectedSig));
  } catch {
    return null;
  }
  if (!ok) return null;

  let claims: SessionClaims;
  try {
    claims = JSON.parse(decoder.decode(fromBase64Url(payload))) as SessionClaims;
  } catch {
    return null;
  }

  if (typeof claims.sub !== "string" || !claims.sub) return null;
  if (typeof claims.exp !== "number" || claims.exp <= now) return null;
  return claims;
}

/**
 * Builds the Set-Cookie header for a session.
 *
 * `secure` is switchable only because http://localhost is not https and a
 * Secure cookie would never be stored during local development. It must stay on
 * everywhere else.
 */
export function sessionCookieHeader(
  token: string,
  options: { maxAge?: number; secure?: boolean } = {},
): string {
  const { maxAge = SESSION_TTL_SECONDS, secure = true } = options;
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : null,
    `Max-Age=${maxAge}`,
  ]
    .filter(Boolean)
    .join("; ");
}

/** Set-Cookie that removes the session immediately. */
export function clearSessionCookieHeader(options: { secure?: boolean } = {}): string {
  const { secure = true } = options;
  return [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : null,
    "Max-Age=0",
  ]
    .filter(Boolean)
    .join("; ");
}

/** Pulls one cookie out of a request's Cookie header. */
export function readCookie(request: Request, name = SESSION_COOKIE): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** True when the request arrived over https, so the cookie can be marked Secure. */
export function isSecureRequest(request: Request): boolean {
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return true;
  }
}
