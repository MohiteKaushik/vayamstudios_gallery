import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Images } from "lucide-react";
import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { PhotoGrid } from "@/components/PhotoGrid";
import { PhotoViewer } from "@/components/PhotoViewer";
import { EmptyState, Shimmer } from "@/components/ui-kit";
import { supabase } from "@/integrations/supabase/client";
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

  const mine = useQuery({
    queryKey: ["my-shared-matches", userId],
    queryFn: async () => {
      const { data } = await supabase
        .from("scan_results")
        .select("similarity, shared_photos(id, storage_path, file_name, width, height, faces_count)")
        .eq("user_id", userId)
        .order("similarity", { ascending: false });
      return (data ?? [])
        .filter((r) => r.shared_photos)
        .map((r) => ({ ...r.shared_photos!, best_similarity: r.similarity }));
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
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Shimmer key={i} className="aspect-[3/4]" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          icon={<Images className="size-7" strokeWidth={1.5} />}
          title="No photos of you yet"
          description="Open a collection and tap “Find me” to pull out the photos you appear in."
        />
      ) : (
        <PhotoGrid photos={list} onOpen={setOpen} />
      )}

      {open !== null && (
        <PhotoViewer photos={list} index={open} onIndexChange={setOpen} onClose={() => setOpen(null)} />
      )}
    </AppShell>
  );
}
