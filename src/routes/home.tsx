import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Layers, UserRound } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { MembersPanel } from "@/components/MembersPanel";
import { WaitingPanel } from "@/components/WaitingPanel";
import { RecycleBinPanel } from "@/components/RecycleBinPanel";
import { EventShowcase } from "@/components/EventShowcase";
import { GlassButton, GlassCard, Shimmer } from "@/components/ui-kit";
import { api } from "@/lib/api";
import { useRequireAuth } from "@/lib/auth-gate";
import { formatCount } from "@/lib/images";
import { useIsAdmin } from "@/lib/roles";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/home")({
  head: () => ({
    meta: [
      { title: "Home | VAYAM Designers Gallery" },
      { name: "description", content: "Set up your face profile, then find yourself in the event photographs." },
      { property: "og:title", content: "Home | VAYAM Designers Gallery" },
      { property: "og:description", content: "Set up your face profile, then find yourself in the event photographs." },
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
    enabled: isAdmin.data === true,
    queryFn: () => api.listCollections().then((c) => c.slice(0, 6)),
  });


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
        Your events
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
            ? "No events yet. Create one from the Recent Event tab and upload photos into it."
            : "Nothing has been published yet. New events will show up here."}
        </p>
      )}
    </section>
  );

  if (admin) {
    return (
      <AppShell>
        <section className="rise-in">
          <h1 className="text-3xl font-semibold tracking-[-0.03em]">Recent Event</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Create an event, then upload the photos. Members see only the frames they appear in.
          </p>
          <Link to="/collections" search={{ shared: undefined }} className="mt-8 inline-flex">
            <GlassButton size="lg" icon={<Layers className="size-4" />}>
              Open recent event
            </GlassButton>
          </Link>
        </section>
        <CoverSettings />
        {collectionList}
        <EventShowcase editable />
        <WaitingPanel />
        <RecycleBinPanel />
        <MembersPanel />
      </AppShell>
    );
  }

  // A member lands on the event, whether or not they have given us a face.
  //
  // This used to open on "Add a reference photo of yourself", and nothing else
  // was reachable until they did. Most people arriving from an event want to
  // look at the photographs first and find themselves afterwards, and a page
  // that demands a selfie before it has shown you anything is a page people
  // close. The ask now happens the first time they press Find me, where the
  // reason for it is obvious, and Settings can change it afterwards.
  return (
    <AppShell>
      <FaceCard />
      <EventShowcase />
    </AppShell>
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
          <h1 className="text-2xl font-semibold tracking-[-0.03em]">The photographs</h1>
          <p className="text-sm text-muted-foreground">
            Open the event to see everything, then press Find me for your own.
          </p>
        </div>
      </div>

      <Link to="/collections" search={{ shared: undefined }}>
        <RecentEventCard />
      </Link>
    </section>
  );
}

function useHomeCover() {
  return useQuery({ queryKey: ["home-cover"], retry: false, queryFn: api.homeCover });
}

/** The card that opens the event, over a blurred photo the admin chose. */
function RecentEventCard() {
  const cover = useHomeCover().data?.coverUrl;
  return (
    <GlassCard interactive className="relative isolate flex flex-col items-center overflow-hidden px-6 py-14 text-center">
      {cover && (
        <>
          <img
            src={cover}
            alt=""
            aria-hidden
            className="absolute inset-0 -z-10 size-full scale-105 object-cover blur-[4px]"
          />
          <div aria-hidden className="absolute inset-0 -z-10 bg-background/50" />
        </>
      )}
      <Layers className={cn("mb-5 size-8", cover ? "text-foreground/80" : "text-muted-foreground")} strokeWidth={1.4} />
      <p className={cn("text-lg font-medium tracking-[-0.02em]", cover && "drop-shadow-[0_1px_8px_rgba(0,0,0,0.65)]")}>
        Open recent event
      </p>
      <p className={cn("mt-1 text-sm", cover ? "text-foreground/80" : "text-muted-foreground")}>
        Photos are published by the organisers
      </p>
    </GlassCard>
  );
}

/** Admin: what members see at the top of their home page, and how to change it. */
function CoverSettings() {
  const qc = useQueryClient();
  const cover = useHomeCover();
  return (
    <section className="mt-12">
      <h2 className="mb-1 text-sm font-medium uppercase tracking-[0.12em] text-muted-foreground">Home cover</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        {cover.data?.coverUrl
          ? "Members see this at the top of their home page. To change it, open an event, select one photo and press Use as home cover."
          : "No cover yet. Open an event, select one photo and press Use as home cover."}
      </p>
      <RecentEventCard />
      {cover.data?.coverUrl && (
        <div className="mt-3 flex justify-end">
          <GlassButton
            variant="ghost"
            size="sm"
            onClick={() =>
              void api.clearHomeCover().then(() => qc.invalidateQueries({ queryKey: ["home-cover"] }))
            }
          >
            Remove cover
          </GlassButton>
        </div>
      )}
    </section>
  );
}
