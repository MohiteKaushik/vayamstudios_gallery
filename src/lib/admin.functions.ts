import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Admin console access.
 *
 * This used to provision the operator account through Supabase's service-role
 * client, which meant the console could not be opened at all until
 * SUPABASE_SERVICE_ROLE_KEY was configured. That key bypasses every access rule
 * in the database, so needing it just to log in was both a setup blocker and
 * more privilege than the job required.
 *
 * Now the operator signs in as an ordinary Supabase user and the server decides
 * whether they are an admin by comparing the email in their verified token to
 * ADMIN_EMAIL. No elevated key is involved. The service-role key is still
 * needed to read the member list, because listing other people's accounts
 * genuinely requires it, and that panel degrades on its own when it is absent.
 */

/** Compares two strings in time that does not depend on where they differ. */
function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  // Length is not secret, but bail in constant work rather than early-return.
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function adminEmail(): string {
  const email = process.env["ADMIN_EMAIL"];
  if (!email) throw new Error("ADMIN_EMAIL is not set in .env");
  return email.trim().toLowerCase();
}

export type AdminCheck = { ok: boolean; accountMissing?: boolean };

/**
 * Confirms the typed operator credentials against the server's own copy before
 * the browser is allowed to sign in or create the account.
 *
 * Both fields are checked, and a failure never says which one was wrong. The
 * password gate matters most on first run: without it, whoever reached the app
 * first could sign up as the admin address and inherit the console.
 */
export const checkAdminCredentials = createServerFn({ method: "POST" })
  .inputValidator((data: { email: string; password: string }) => data)
  .handler(async ({ data }): Promise<AdminCheck> => {
    const expectedPassword = process.env["ADMIN_PASSWORD"];
    if (!expectedPassword) throw new Error("ADMIN_PASSWORD is not set in .env");

    const emailOk = constantTimeEqual(data.email.trim().toLowerCase(), adminEmail());
    const passwordOk = constantTimeEqual(data.password, expectedPassword);
    return { ok: emailOk && passwordOk };
  });

/**
 * Whether the caller's own verified session is the operator.
 *
 * The middleware validates the token, so the email here comes from Supabase
 * rather than from anything the browser claimed. A stored admin role is also
 * honoured, so accounts promoted directly in the database keep working.
 */
export const isAdminSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<boolean> => {
    const { supabase, userId, claims } = context;

    const email = typeof claims["email"] === "string" ? claims["email"].toLowerCase() : null;
    if (email && email === adminEmail()) return true;

    const { data } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "admin")
      .maybeSingle();
    return !!data;
  });

/**
 * Records the admin role in the database once the operator has signed in.
 *
 * Best effort. Access rules may forbid a user writing their own role, in which
 * case nothing is written and `isAdminSession` still recognises them by email.
 * This exists only so other tables that join on user_roles behave.
 */
export const claimAdminRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ recorded: boolean }> => {
    const { supabase, userId, claims } = context;
    const email = typeof claims["email"] === "string" ? claims["email"].toLowerCase() : null;
    if (!email || email !== adminEmail()) return { recorded: false };

    const { error } = await supabase
      .from("user_roles")
      .upsert({ user_id: userId, role: "admin" }, { onConflict: "user_id,role" });
    return { recorded: !error };
  });
