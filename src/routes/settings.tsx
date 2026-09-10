import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { GlassButton, GlassCard, useConfirm } from "@/components/ui-kit";
import { api } from "@/lib/api";
import { useRequireAuth } from "@/lib/auth-gate";
import { useSession } from "@/lib/session";
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
  const { signOut: endSession } = useSession();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  async function resetFace() {
    setBusy("face");
    try {
      const r = await api.forgetFace();
      qc.invalidateQueries();
      toast.success(
        r.clearedScans > 0
          ? `Face profile removed, and ${r.clearedScans} past scan(s) cleared`
          : "Face profile removed",
      );
      navigate({ to: "/home" });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not remove your face profile");
    } finally {
      setBusy(null);
    }
  }

  // Members do not own photos; collections belong to the studio. Clearing a
  // members own data means clearing their face and their scan results, which
  // resetFace already does completely.
  const { ask, dialog } = useConfirm();

  async function deleteAll() {
    const ok = await ask({
      title: "Remove your face profile?",
      body: "Your reference face and every saved result are deleted. This cannot be undone.",
      confirmLabel: "Remove",
    });
    if (ok) await resetFace();
  }

  async function signOut() {
    await endSession();
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
      {dialog}
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
