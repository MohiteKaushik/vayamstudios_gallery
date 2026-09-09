import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Layers, ScanFace, UserRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { MembersPanel } from "@/components/MembersPanel";
import { EventShowcase } from "@/components/EventShowcase";
import { EmptyState, GlassButton, GlassCard, Shimmer } from "@/components/ui-kit";
import { supabase } from "@/integrations/supabase/client";
import { useRequireAuth } from "@/lib/auth-gate";
import { loadEngine } from "@/lib/face";
import { formatCount } from "@/lib/images";
import { signedUrl } from "@/lib/photo-urls";
import { saveFaceProfile } from "@/lib/pipeline";
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
  const profile = useQuery({
    queryKey: ["face-profile", userId],
    queryFn: async () => {
      const { data } = await supabase
        .from("face_profiles")
        .select("id, image_path, descriptor")
        .eq("user_id", userId)
        .maybeSingle();
      return data ?? null;
    },
  });
  const sharedCollections = useQuery({
    queryKey: ["shared-collections"],
    queryFn: async () => {
      const { data } = await supabase
        .from("shared_collections")
        .select("id, name, description, created_at, shared_photos(count)")
        .order("created_at", { ascending: false })
        .limit(6);
      return data ?? [];
    },
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
              <Link to="/collections" search={{ shared: c.id }}>
                <GlassCard interactive className="flex items-center justify-between px-5 py-4">
                  <div>
                    <p className="font-medium tracking-[-0.01em]">{c.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatCount(c.shared_photos?.[0]?.count ?? 0, "photo")}
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
          <FaceCard profilePath={profile.data.image_path} />
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
      const { error } = await saveFaceProfile(userId, file);
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

function FaceCard({ profilePath }: { profilePath: string }) {
  const [avatar, setAvatar] = useState<string | null>(null);

  useEffect(() => {
    signedUrl(profilePath).then(setAvatar);
  }, [profilePath]);

  return (
    <section className="rise-in">
      <div className="mb-8 flex items-center gap-4">
        <div className="size-14 overflow-hidden rounded-full bg-secondary">
          {avatar && <img src={avatar} alt="Your reference face" className="size-full object-cover" />}
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
