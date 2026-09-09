import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { MemberRow } from "@/lib/members";

/**
 * Client data for the admin console.
 *
 * Every guard here is server-side on purpose. The browser saying "I am an
 * admin" means nothing: the caller's own token is verified by the middleware,
 * then their admin role is checked against the database, and only then is the
 * service-role key used to read the member list. Hiding the button in the
 * interface is presentation, not access control.
 */
export const listMembers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<MemberRow[]> => {
    const { supabase, userId } = context;

    // The caller's own client, subject to row-level security, answers whether
    // they are an admin. Never take that claim from the request body.
    const { data: role } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "admin")
      .maybeSingle();
    if (!role) throw new Error("Admins only");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const admins = new Set<string>();
    const { data: adminRows } = await supabaseAdmin.from("user_roles").select("user_id").eq("role", "admin");
    for (const r of adminRows ?? []) admins.add(r.user_id);

    const [{ data: faceRows }, { data: scanRows }, { data: profileRows }] = await Promise.all([
      supabaseAdmin.from("face_profiles").select("user_id"),
      supabaseAdmin.from("scan_results").select("user_id"),
      supabaseAdmin.from("profiles").select("id, full_name, email"),
    ]);

    const withFace = new Set((faceRows ?? []).map((r) => r.user_id));
    const photoCounts = new Map<string, number>();
    for (const r of scanRows ?? []) photoCounts.set(r.user_id, (photoCounts.get(r.user_id) ?? 0) + 1);
    const profiles = new Map((profileRows ?? []).map((p) => [p.id, p]));

    // Name and phone are collected at sign-up and live on the auth user, so no
    // schema change was needed to start capturing them.
    const rows: MemberRow[] = [];
    let page = 1;
    for (;;) {
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw new Error(error.message);
      const users = data?.users ?? [];
      for (const u of users) {
        if (admins.has(u.id)) continue; // operators are staff, not clients
        const meta = (u.user_metadata ?? {}) as { full_name?: string; phone?: string };
        const profile = profiles.get(u.id);
        rows.push({
          id: u.id,
          fullName: meta.full_name ?? profile?.full_name ?? "",
          phone: meta.phone ?? "",
          email: u.email ?? profile?.email ?? "",
          joinedAt: u.created_at ?? null,
          lastSignInAt: u.last_sign_in_at ?? null,
          hasFaceProfile: withFace.has(u.id),
          photosFound: photoCounts.get(u.id) ?? 0,
        });
      }
      if (users.length < 200) break;
      page++;
    }

    rows.sort((a, b) => (b.joinedAt ?? "").localeCompare(a.joinedAt ?? ""));
    return rows;
  });
