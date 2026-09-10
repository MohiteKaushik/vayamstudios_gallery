import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Images } from "lucide-react";
import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { PhotoGrid, PhotoGridSkeleton, type GridPhoto } from "@/components/PhotoGrid";
import { PhotoViewer } from "@/components/PhotoViewer";
import { EmptyState } from "@/components/ui-kit";
import { api } from "@/lib/api";
import { useRequireAuth } from "@/lib/auth-gate";
import { formatCount } from "@/lib/images";

export const Route = createFileRoute("/photos")({
  head: () => ({
    meta: [
      { title: "Photos — VAYAM Designers Gallery" },
      { name: "description", content: "Every photo you appear in, in one place." },
      { property: "og:title", content: "Photos — VAYAM Designers Gallery" },
      { property: "og:description", content: "Every photo you appear in, in one place." },
    ],
  }),
  component: PhotosPage,
});

function PhotosPage() {
  const { user } = useRequireAuth();
  if (!user) return null;
  return <Photos userId={user.id} />;
}

function Photos({ userId }: { userId: string }) {
  const [open, setOpen] = useState<number | null>(null);

  // Every collection this member has scanned, gathered from their cached
  // results. Each of those is one read, so this stays cheap even with many
  // collections, and it needs no new endpoint.
  const mine = useQuery({
    queryKey: ["my-photos", userId],
    retry: false,
    queryFn: async (): Promise<GridPhoto[]> => {
      const collections = await api.listCollections();
      const scans = await Promise.all(
        collections.map((c) => api.cachedScan(c.id).catch(() => null)),
      );
      return scans
        .flatMap((s) => s?.hits ?? [])
        .sort((a, b) => b.confidence - a.confidence)
        .map((h) => ({
          id: h.photoId,
          thumbUrl: h.thumbUrl,
          fullUrl: h.fullUrl,
          width: h.width,
          height: h.height,
          fileName: h.fileName,
          confidence: h.confidence,
        }));
    },
  });

  const list = mine.data ?? [];

  return (
    <AppShell wide>
      <div className="mb-8">
        <h1 className="text-3xl font-semibold tracking-[-0.03em]">Photos of you</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {mine.isLoading ? "Loading…" : formatCount(list.length, "photo")}
        </p>
      </div>

      {mine.isLoading ? (
        <PhotoGridSkeleton />
      ) : list.length === 0 ? (
        <EmptyState
          icon={<Images className="size-7" strokeWidth={1.5} />}
          title="No photos of you yet"
          description="Open a collection and tap “Find me” to pull out the photos you appear in."
        />
      ) : (
        <PhotoGrid photos={list} onOpen={setOpen} showConfidence />
      )}

      {open !== null && (
        <PhotoViewer photos={list} index={open} onIndexChange={setOpen} onClose={() => setOpen(null)} />
      )}
    </AppShell>
  );
}
