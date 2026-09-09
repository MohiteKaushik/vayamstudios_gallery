import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { GlassButton, GlassCard } from "@/components/ui-kit";
import { supabase } from "@/integrations/supabase/client";
import { useRequireAuth } from "@/lib/auth-gate";
import { useTheme, type ThemePref } from "@/lib/theme";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings — VAYAM Designers Gallery" },
      { name: "description", content: "Appearance, privacy and account controls for VAYAM Designers Gallery." },
      { property: "og:title", content: "Settings — VAYAM Designers Gallery" },
      { property: "og:description", content: "Appearance, privacy and account controls for VAYAM Designers Gallery." },
    ],
  }),
  component: SettingsPage,
});

function SettingsPage() {
  const { user } = useRequireAuth();
  if (!user) return null;
  return <Settings userId={user.id} email={user.email ?? ""} />;
}

function Settings({ userId, email }: { userId: string; email: string }) {
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  async function resetFace() {
    setBusy("face");
    const { data } = await supabase.from("face_profiles").select("image_path").eq("user_id", userId);
    if (data?.length) await supabase.storage.from("photos").remove(data.map((d) => d.image_path));
    await supabase.from("face_profiles").delete().eq("user_id", userId);
    qc.invalidateQueries({ queryKey: ["face-profile", userId] });
    setBusy(null);
    toast.success("Face profile removed");
    navigate({ to: "/home" });
  }

  async function deleteAll() {
    if (!confirm("Delete every uploaded photo and search? This cannot be undone.")) return;
    setBusy("all");
    const { data } = await supabase.from("photos").select("storage_path").eq("user_id", userId);
    const paths = (data ?? []).map((p) => p.storage_path);
    for (let i = 0; i < paths.length; i += 100) {
      await supabase.storage.from("photos").remove(paths.slice(i, i + 100));
    }
    await supabase.from("search_sessions").delete().eq("user_id", userId);
    await supabase.from("collections").delete().eq("user_id", userId);
    qc.invalidateQueries();
    setBusy(null);
    toast.success("All photos deleted");
  }

  async function signOut() {
    await supabase.auth.signOut();
    navigate({ to: "/" });
  }

  return (
    <AppShell>
      <h1 className="text-3xl font-semibold tracking-[-0.03em]">Settings</h1>

      <Section title="Appearance">
        <div className="flex rounded-full bg-secondary p-1 text-sm">
          {(["light", "system", "dark"] as ThemePref[]).map((t) => (
            <button
              key={t}
              onClick={() => setTheme(t)}
              className={`press flex-1 rounded-full px-4 py-1.5 capitalize ${theme === t ? "bg-background shadow-[var(--shadow-soft)]" : "text-muted-foreground"}`}
            >
              {t}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Privacy">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Face analysis runs entirely on your device. Only your photos and a numeric face signature are stored in your private account so results can be shown again later.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <GlassButton variant="quiet" size="sm" loading={busy === "face"} onClick={resetFace}>
            Replace reference face
          </GlassButton>
          <GlassButton variant="danger" size="sm" loading={busy === "all"} onClick={deleteAll}>
            Delete all photos
          </GlassButton>
        </div>
      </Section>

      <Section title="Account">
        <p className="text-sm text-muted-foreground">{email}</p>
        <GlassButton variant="quiet" size="sm" className="mt-4" onClick={signOut}>
          Sign out
        </GlassButton>
      </Section>
    </AppShell>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <GlassCard className="mt-6 p-6">
      <h2 className="mb-4 text-sm font-medium uppercase tracking-[0.12em] text-muted-foreground">{title}</h2>
      {children}
    </GlassCard>
  );
}
