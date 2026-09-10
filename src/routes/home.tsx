import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Layers, ScanFace, UserRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { MembersPanel } from "@/components/MembersPanel";
import { EventShowcase } from "@/components/EventShowcase";
import { EmptyState, GlassButton, GlassCard, Shimmer } from "@/components/ui-kit";
import { api } from "@/lib/api";
import { useRequireAuth } from "@/lib/auth-gate";
import { loadEngine } from "@/lib/face";
import { formatCount } from "@/lib/images";
import { enrolFace } from "@/lib/enroll";
import { useIsAdmin } from "@/lib/roles";

export const Route = createFileRoute("/home")({
  head: () => ({
    meta: [
      { title: "Home — VAYAM Designers Gallery" },
      { name: "description", content: "Set up your face profile, then find yourself in shared collections." },
      { property: "og:title", content: "Home — VAYAM Designers Gallery" },
      { property: "og:description", content: "Set up your face profile, then find yourself in shared collections." },
    ],
  }),
  component: HomePage,
});

function HomePage() {
  const { user } = useRequireAuth();
  if (!user) return null;
  return <Home userId={user.id} />;
}

function Home({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const isAdmin = useIsAdmin(userId);
  // Whether this member has enrolled comes from their own record now.
  const profile = useQuery({
    queryKey: ["face-profile", userId],
    retry: false,
    queryFn: () => api.me().then((m) => (m.onboarded ? m : null)).catch(() => null),
  });
  const sharedCollections = useQuery({
    queryKey: ["collections"],
    retry: false,
    queryFn: () => api.listCollections().then((c) => c.slice(0, 6)),
  });

  useEffect(() => {
    loadEngine().catch(() => {});
  }, []);

  if (profile.isLoading || isAdmin.isLoading) {
    return (
      <AppShell>
        <Shimmer className="h-64" />
      </AppShell>
    );
  }

  const admin = isAdmin.data === true;

  const collectionList = (
    <section className="mt-12">
      <h2 className="mb-4 text-sm font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {admin ? "Your collections" : "Collections to scan"}
      </h2>
      {sharedCollections.isLoading ? (
        <Shimmer className="h-16" />
      ) : sharedCollections.data?.length ? (
        <ul className="space-y-2">
          {sharedCollections.data.map((c) => (
            <li key={c.id}>
              <Link to="/collections" search={{ shared: c.id }} aria-label={`Open ${c.name}`}>
                <GlassCard interactive className="flex items-center justify-between px-5 py-4">
                  <div>
                    <p className="font-medium tracking-[-0.01em]">{c.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatCount(c.photoCount, "photo")}
                      {c.description ? ` · ${c.description}` : ""}
                    </p>
                  </div>
                  <span className="rounded-full bg-secondary px-3 py-1 text-xs font-medium">
                    {admin ? "Manage" : "Find me"}
                  </span>
                </GlassCard>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          {admin
            ? "No collections yet. Create one from the Collections tab and upload photos into it."
            : "Nothing has been published yet. New collections will show up here."}
        </p>
      )}
    </section>
  );

  if (admin) {
    return (
      <AppShell>
        <section className="rise-in">
          <h1 className="text-3xl font-semibold tracking-[-0.03em]">Collections</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Create a collection, then upload the photos. Members see only the frames they appear in.
          </p>
          <Link to="/collections" search={{ shared: undefined }} className="mt-8 inline-flex">
            <GlassButton size="lg" icon={<Layers className="size-4" />}>
              Open collections
            </GlassButton>
          </Link>
        </section>
        {collectionList}
        <MembersPanel />
      </AppShell>
    );
  }

  return (
    <AppShell>
      {!profile.data ? (
        <FaceSetup userId={userId} onDone={() => qc.invalidateQueries({ queryKey: ["face-profile", userId] })} />
      ) : (
        <>
          <FaceCard />
          {collectionList}
        </>
      )}
      {/* Past work, shown whether or not the face profile exists yet, so a
          member who has just signed up is not left staring at one upload prompt. */}
      <EventShowcase />
    </AppShell>
  );
}


function FaceSetup({ userId, onDone }: { userId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function pick(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      const { error } = await enrolFace(file);
      if (error) toast.error(error);
      else {
        toast.success("Face profile saved");
        onDone();
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <EmptyState
      icon={<ScanFace className="size-7" strokeWidth={1.5} />}
      title="Add a reference photo of yourself"
      description="A clear, front-facing photo works best. It's analysed on your device and used only to recognise you."
      action={
        <>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => pick(e.target.files?.[0])}
          />
          <GlassButton size="lg" loading={busy} icon={<UserRound className="size-4" />} onClick={() => inputRef.current?.click()}>
            {busy ? "Analysing…" : "Choose photo"}
          </GlassButton>
        </>
      }
    />
  );
}

function FaceCard() {
  return (
    <section className="rise-in">
      <div className="mb-8 flex items-center gap-4">
        <div className="flex size-14 items-center justify-center overflow-hidden rounded-full bg-secondary">
          <UserRound className="size-6 text-muted-foreground" strokeWidth={1.5} />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.03em]">Find yourself</h1>
          <p className="text-sm text-muted-foreground">
            Open a published collection and we'll pull out the photos you appear in.
          </p>
        </div>
      </div>

      <Link to="/collections" search={{ shared: undefined }}>
        <GlassCard interactive className="flex flex-col items-center px-6 py-14 text-center">
          <Layers className="mb-5 size-8 text-muted-foreground" strokeWidth={1.4} />
          <p className="text-lg font-medium tracking-[-0.02em]">Browse collections</p>
          <p className="mt-1 text-sm text-muted-foreground">Photos are published by the organisers</p>
        </GlassCard>
      </Link>
    </section>
  );
}
