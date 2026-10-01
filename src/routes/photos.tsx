import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Images, ScanFace } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AppShell } from "@/components/AppShell";
import { FaceEnrolSheet } from "@/components/FaceEnrolSheet";
import { PhotoGrid, PhotoGridSkeleton, type GridPhoto } from "@/components/PhotoGrid";
import { PhotoSelectionToolbar } from "@/components/PhotoSelectionToolbar";
import { PhotoViewer } from "@/components/PhotoViewer";
import { EmptyState, GlassButton } from "@/components/ui-kit";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { api } from "@/lib/api";
import { autoScanSnapshot, startAutoScan, subscribeAutoScan } from "@/lib/auto-scan";
import { useRequireAuth } from "@/lib/auth-gate";
import { formatCount } from "@/lib/images";
import { usePhotoDownload } from "@/lib/use-photo-download";
import { usePhotoSelection } from "@/lib/photo-selection";

type MemberPhoto = GridPhoto & { photoId: string };

export const Route = createFileRoute("/photos")({
  head: () => ({
    meta: [
      { title: "Photos | VAYAM Designers Gallery" },
      { name: "description", content: "Every photo you appear in, in one place." },
      { property: "og:title", content: "Photos | VAYAM Designers Gallery" },
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
  const qc = useQueryClient();
  const [open, setOpen] = useState<number | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const scan = useSyncExternalStore(subscribeAutoScan, autoScanSnapshot, autoScanSnapshot);
  const profile = useQuery({ queryKey: ["my-photo-profile", userId], queryFn: api.me, retry: false });

  useEffect(() => { void startAutoScan(userId); }, [userId]);
  const lastCompleted = useRef(0);
  useEffect(() => {
    if (scan.userId !== userId) return;
    if (scan.phase === "preparing") lastCompleted.current = 0;
    if (scan.completed > lastCompleted.current) {
      lastCompleted.current = scan.completed;
      void qc.invalidateQueries({ queryKey: ["my-photos", userId] });
    }
  }, [scan, qc, userId]);

  // Every collection this member has scanned, gathered from their cached
  // results. Each of those is one read, so this stays cheap even with many
  // collections, and it needs no new endpoint.
  const mine = useQuery({
    queryKey: ["my-photos", userId],
    retry: false,
    enabled: profile.data?.onboarded === true,
    queryFn: async (): Promise<MemberPhoto[]> => {
      const collections = await api.listCollections();
      const scans: { collectionId: string; result: Awaited<ReturnType<typeof api.cachedScan>> | null }[] = [];
      for (let i = 0; i < collections.length; i += 4) {
        scans.push(...await Promise.all(collections.slice(i, i + 4).map(async (collection) => ({
          collectionId: collection.id,
          result: await api.cachedScan(collection.id).catch(() => null),
        }))));
      }
      return scans
        .flatMap(({ collectionId, result }) => (result?.hits ?? []).map((hit) => ({ collectionId, hit })))
        .sort((a, b) => b.hit.confidence - a.hit.confidence)
        .map(({ collectionId, hit }) => ({
          // Photo ids are unique inside an event. Include the event so a
          // combined gallery remains stable even for older repeated ids.
          id: `${collectionId}:${hit.photoId}`,
          photoId: hit.photoId,
          thumbUrl: hit.thumbUrl,
          fullUrl: hit.fullUrl,
          width: hit.width,
          height: hit.height,
          fileName: hit.fileName,
          confidence: hit.confidence,
        }));
    },
  });

  const list = profile.data?.onboarded ? (mine.data ?? []) : [];
  const selection = usePhotoSelection(list);
  const scanning = (scan.userId === userId || scan.userId === null) &&
    (scan.phase === "preparing" || scan.phase === "scanning");
  const scanFailed = scan.userId === userId && scan.phase === "error";

  return (
    <AppShell wide>
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-[-0.03em]">Photos of you</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {mine.isLoading ? "Loading…" : formatCount(list.length, "photo")}
          </p>
        </div>
        {list.length > 0 && !selection.active ? <DownloadAllPhotos photos={list} /> : null}
      </div>

      <PhotoSelectionToolbar
        photos={selection.selectedPhotos}
        total={list.length}
        label="Selected-Photos"
        onClear={selection.clear}
        onSelectAll={selection.selectAll}
      />

      {scanning && profile.data?.onboarded && (
        <div role="status" className="mb-6 flex items-center gap-3 rounded-lg border border-border bg-secondary/50 px-4 py-3 text-sm">
          <ScanFace className="size-5 shrink-0 animate-pulse" />
          <span>{scan.phase === "preparing" ? "Checking your events…" : `Finding your photos across events… ${scan.completed} of ${scan.total} checked`}</span>
        </div>
      )}
      {scanFailed && profile.data?.onboarded && (
        <div role="alert" className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-secondary/50 px-4 py-3 text-sm">
          <span>Some events could not be searched. Your other matches are shown below.</span>
          <GlassButton variant="quiet" size="sm" onClick={() => void startAutoScan(userId)}>Try again</GlassButton>
        </div>
      )}

      {mine.isLoading ? (
        <PhotoGridSkeleton />
      ) : !profile.isLoading && !profile.data?.onboarded ? (
        <EmptyState
          icon={<ScanFace className="size-7" strokeWidth={1.5} />}
          title="Find your photos"
          description="Add a photo of your face and we'll search every available event for you."
          action={<GlassButton onClick={() => setEnrolling(true)}>Add reference photo</GlassButton>}
        />
      ) : list.length === 0 && scanning ? (
        <PhotoGridSkeleton />
      ) : list.length === 0 ? (
        <EmptyState
          icon={<Images className="size-7" strokeWidth={1.5} />}
          title="No photos of you yet"
          description="We have searched the available events. New matches will appear here as events are added."
        />
      ) : (
        <PhotoGrid
          photos={list}
          onOpen={setOpen}
          selected={selection.selected}
          onToggleSelect={selection.toggle}
          selectionMode={selection.active}
          onLongPress={selection.start}
          showConfidence
        />
      )}

      {open !== null && (
        <PhotoViewer photos={list} index={open} onIndexChange={setOpen} onClose={() => setOpen(null)} />
      )}
      {enrolling && (
        <FaceEnrolSheet
          onClose={() => setEnrolling(false)}
          onDone={() => {
            setEnrolling(false);
            void qc.invalidateQueries({ queryKey: ["my-photo-profile", userId] });
            void qc.invalidateQueries({ queryKey: ["my-photos", userId] });
          }}
        />
      )}
    </AppShell>
  );
}

function DownloadAllPhotos({ photos }: { photos: MemberPhoto[] }) {
  const download = usePhotoDownload(photos, "My-Photos");

  return (
    <div className="flex max-w-sm flex-col items-end gap-2">
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <GlassButton
            type="button"
            variant="quiet"
            loading={download.downloading}
            icon={<Download className="size-4" />}
          >
            Download all
          </GlassButton>
        </AlertDialogTrigger>
        <AlertDialogContent className="w-[calc(100%-2rem)] rounded-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Review photos before sharing</AlertDialogTitle>
            <AlertDialogDescription className="leading-relaxed">
              Some photos may include other attendees. Please review the downloaded images before sharing or uploading them, and respect everyone&apos;s privacy.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void download.start()} className="gap-2">
              <Download className="size-4" /> Continue &amp; download
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {download.message ? <p aria-live="polite" className="text-right text-xs text-muted-foreground">{download.message}</p> : null}
    </div>
  );
}
