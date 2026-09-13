/**
 * Whether this browser has signed in to the gallery before.
 *
 * Used for one decision: where "Get started" leads. A first visit opens on
 * creating an account, a returning device opens on signing in. Stored locally
 * and nowhere else, because it describes the device, not the person, and it
 * must never be mistaken for being signed in.
 */
const KEY = "vayam:known-device";

export function isKnownDevice(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(KEY) === "1";
  } catch {
    // Private windows and locked-down browsers throw on access. Treat that as
    // a first visit, which only costs one extra tap.
    return false;
  }
}

export function rememberDevice(): void {
  try {
    window.localStorage.setItem(KEY, "1");
  } catch {
    // Nowhere to remember it. The next visit opens on creating an account.
  }
}
