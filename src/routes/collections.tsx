import { createFileRoute } from "@tanstack/react-router";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import { Check, CheckCheck, ChevronLeft, Copy, FolderPlus, Image as ImageIcon, ImagePlus, Layers, Loader2, Pencil, Plus, Radio, RefreshCw, ScanFace, Search, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { ScanProgress } from "@/components/ScanProgress";
import { PhotoGrid, PhotoGridSkeleton, type GridPhoto } from "@/components/PhotoGrid";
import { PagedPhotoGrid } from "@/components/PagedPhotoGrid";
import { stablePhotoPages } from "@/lib/photo-pages";
import { PhotoViewer } from "@/components/PhotoViewer";
import { FaceEnrolSheet } from "@/components/FaceEnrolSheet";
import { EmptyState, GlassButton, GlassCard, Shimmer, useConfirm } from "@/components/ui-kit";
import { useRequireAuth } from "@/lib/auth-gate";
import { formatCount } from "@/lib/images";
import { api, ApiError, confidencePercent, type Photo, type ScanHit, type ScanResult } from "@/lib/api";
import { uploadPhotos, type BulkProgress } from "@/lib/upload";
import { keepIndexing, reanalyseCollection } from "@/lib/reanalyse";
import { DuplicatesPanel } from "@/components/DuplicatesPanel";
import { dayLabel, timeLabel } from "@/lib/time";
import { useIsAdmin } from "@/lib/roles";
import { confirmEventDeletion } from "@/lib/confirm-event-deletion";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const PHOTO_PAGE_SIZE = 40;

export const Route = createFileRoute("/collections")({
  validateSearch: (s: Record<string, unknown>): { shared: string | undefined; event?: string } => ({
    shared: typeof s["shared"] === "string" ? s["shared"] : undefined,
    ...(typeof s["event"] === "string" ? { event: s["event"] } : {}),
  }),
  head: () => ({
    meta: [
      { title: "Recent Events | VAYAM Designers Gallery" },
      { name: "description", content: "Find yourself in the photographs from the event." },
      { property: "og:title", content: "Recent Events | VAYAM Designers Gallery" },
      { property: "og:description", content: "Find yourself in the photographs from the event." },
    ],
  }),
  component: CollectionsPage,
});

function CollectionsPage() {
  const { user } = useRequireAuth();
  const isAdmin = useIsAdmin(user?.id);
  if (!user || isAdmin.isLoading) return null;
  return <Collections isAdmin={!!isAdmin.data} />;
}

function Collections({ isAdmin }: { isAdmin: boolean }) {
  const { ask, dialog } = useConfirm();
  const { shared, event } = Route.useSearch();
  const navigate = Route.useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [showAll, setShowAll] = useState(false);
  const allEvents = (isAdmin && showAll) || !!shared;

  const collections = useQuery({
    queryKey: allEvents ? ["collections"] : ["recent-collections"],
    queryFn: allEvents ? api.listCollections : api.listRecentCollections,
    enabled: event === undefined,
    retry: false,
  });
  const eventCollections = useQuery({
    queryKey: ["collections", "event", event],
    queryFn: () => api.listEventCollections(event!),
    enabled: event !== undefined,
    retry: false,
  });
  const showcase = useQuery({
    queryKey: ["showcase-events"],
    queryFn: api.showcaseEvents,
    enabled: event === undefined,
    retry: false,
  });
  const listing = event !== undefined ? eventCollections : collections;
  const albums = event !== undefined ? eventCollections.data?.collections : collections.data;
  const eventName = eventCollections.data?.event.name;
  const selectedAlbum = shared;
  const topLevelEvents = (showcase.data ?? []).filter((item) =>
    isAdmin && showAll ? true : item.recent && !item.hidden);

  const create = useMutation({
    mutationFn: () => api.createCollection(name.trim(), description.trim() || undefined),
    onSuccess: (created) => {
      setName("");
      setDescription("");
      qc.invalidateQueries({ queryKey: ["collections"] });
      qc.invalidateQueries({ queryKey: ["showcase-events"] });
      qc.invalidateQueries({ queryKey: ["recent-collections"] });
      navigate({ to: ".", search: { event: created.id, shared: undefined } });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not create the collection"),
  });

  const remove = useMutation({
    mutationFn: (cid: string) => api.deletePhotos(cid),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["collections"] });
      qc.invalidateQueries({ queryKey: ["bin"] });
      qc.invalidateQueries({ queryKey: ["showcase-events"] });
      qc.invalidateQueries({ queryKey: ["recent-collections"] });
      const groupId = r.groupId;
      toast.success("Subfolder moved to the recycle bin", {
        description: "Restore it from the recycle bin in the admin console for 30 days.",
        ...(groupId ? { action: { label: "Undo", onClick: () => void undoFromBin(qc, groupId) } } : {}),
      });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not delete the collection"),
  });

  // Do not fall back to unrelated albums for a missing event or a mismatched shared link.
  if (event !== undefined && (listing.isLoading || listing.isError || (shared && albums && !albums.some((c) => c.id === shared)))) {
    return <AppShell>
      <button onClick={() => navigate({ to: ".", search: { shared: undefined } })}
        className="mb-5 inline-flex items-center gap-1 text-sm text-muted-foreground">
        <ChevronLeft className="size-4" /> Recent Events
      </button>
      {listing.isLoading ? <Shimmer className="h-40" /> : <EmptyState tone="error"
        icon={<Layers className="size-7" />} title="Event unavailable"
        description={listing.error instanceof Error ? listing.error.message : "This album does not belong to the selected event."} />}
    </AppShell>;
  }

  if (selectedAlbum) {
    const current = albums?.find((c) => c.id === selectedAlbum);
    const backToEvent = event !== undefined;
    const selectedEventId = event ?? current?.showcaseEventId;
    return (
      <AppShell wide>
        <button
          onClick={() => navigate({ to: ".", search: { shared: undefined, ...(backToEvent ? { event } : {}) } })}
          className="press mb-5 inline-flex items-center gap-1 rounded-full text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronLeft className="size-4" /> {backToEvent ? eventName : "Recent Events"}
        </button>
        {isAdmin ? (
          <AdminCollection key={selectedAlbum} collectionId={selectedAlbum} name={current?.name ?? "Collection"}
            {...(selectedEventId ? { eventId: selectedEventId } : {})} />
        ) : (
          <MemberCollection key={selectedAlbum} collectionId={selectedAlbum} name={current?.name ?? "Collection"} />
        )}
      </AppShell>
    );
  }

  const input =
    "h-12 w-full rounded-2xl border border-hairline bg-background/60 px-5 text-sm outline-none transition focus:ring-2 focus:ring-ring";

  return (
    <AppShell>
      {event !== undefined && <button onClick={() => navigate({ to: ".", search: { shared: undefined } })}
        className="mb-5 inline-flex items-center gap-1 text-sm text-muted-foreground">
        <ChevronLeft className="size-4" /> Recent Events
      </button>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="break-words text-3xl font-semibold tracking-[-0.03em]">{eventName ?? "Recent Events"}</h1>
        {isAdmin && event !== undefined && <SubfolderDialog eventId={event} />}
      </div>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {event !== undefined ? "Select a subfolder to open its photos." : isAdmin
          ? "Create an event, then add the photos to it. Every face is indexed once so members can find themselves."
          : "Open an event and tap Find me. Only the photos that match your reference face appear."}
      </p>

      {isAdmin && event === undefined && (
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
          className="mt-7 space-y-2.5"
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Event name, for example Brand Summit 2026"
            className={input}
            aria-label="Collection name"
          />
          <div className="flex flex-col gap-2.5 sm:flex-row">
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Short description (optional)"
              className={input}
              aria-label="Collection description"
            />
            <GlassButton
              type="submit"
              icon={<Plus className="size-4" />}
              loading={create.isPending}
              disabled={!name.trim()}
            >
              New event
            </GlassButton>
          </div>
        </form>
      )}

      <section className="mt-9">
        {isAdmin && event === undefined && <label className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="size-4" />
          Show all events (admin)
        </label>}
        {listing.isLoading || (event === undefined && showcase.isLoading) ? (
          <Shimmer className="h-40" />
        ) : listing.isError || (event === undefined && showcase.isError) ? (
          <EmptyState
            tone="error"
            icon={<Layers className="size-7" strokeWidth={1.5} />}
            title="No events available"
            description={
              listing.error instanceof Error ? listing.error.message
                : showcase.error instanceof Error ? showcase.error.message
                  : "Could not load the events."
            }
          />
        ) : event === undefined && topLevelEvents.length ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {topLevelEvents.map((item) => {
              const folders = (albums ?? []).filter((album) => album.showcaseEventId === item.id);
              const cover = folders.find((folder) => folder.coverUrl)?.coverUrl;
              const photoCount = folders.reduce((total, folder) => total + folder.photoCount, 0);
              return (
                <GlassCard
                  key={item.id}
                  interactive
                  aria-label={`Open ${item.name} subfolders`}
                  onClick={() => navigate({ to: ".", search: { event: item.id, shared: undefined } })}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      navigate({ to: ".", search: { event: item.id, shared: undefined } });
                    }
                  }}
                  className="group overflow-hidden"
                >
                  <div className="flex aspect-[16/10] items-center justify-center overflow-hidden bg-secondary">
                    {cover
                      ? <img src={cover} alt="" loading="lazy"
                          className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
                      : <Layers className="size-10 text-muted-foreground" strokeWidth={1.4} />}
                  </div>
                  <div className="px-5 py-4">
                    <p className="truncate font-medium tracking-[-0.01em]">{item.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {formatCount(item.collectionIds.length, "subfolder")} · {formatCount(photoCount, "photo")}
                    </p>
                  </div>
                </GlassCard>
              );
            })}
          </div>
        ) : event !== undefined && albums?.length ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {albums.map((c) => (
              <GlassCard
                key={c.id}
                interactive
                aria-label={`Open ${c.name}`}
                onClick={() => navigate({ to: ".", search: { shared: c.id, ...(event !== undefined ? { event } : {}) } })}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    navigate({ to: ".", search: { shared: c.id, ...(event !== undefined ? { event } : {}) } });
                  }
                }}
                className="group overflow-hidden"
              >
                <div className="aspect-[16/10] overflow-hidden bg-secondary">
                  {c.coverUrl && (
                    <img
                      src={c.coverUrl}
                      alt=""
                      loading="lazy"
                      className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                    />
                  )}
                </div>
                <div className="flex items-start justify-between gap-3 px-5 py-4">
                  <div className="min-w-0">
                    <p className="truncate font-medium tracking-[-0.01em]">{c.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {formatCount(c.photoCount, "photo")}
                      {c.description ? ` · ${c.description}` : ""}
                    </p>
                  </div>
                  {isAdmin && (
                    <button
                      aria-label={`Delete ${c.name}`}
                      disabled={remove.isPending}
                      onClick={async (e) => {
                        e.stopPropagation();
                        const ok = await confirmEventDeletion(ask, c.name);
                        if (ok) remove.mutate(c.id);
                      }}
                      className="press shrink-0 rounded-full p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  )}
                </div>
              </GlassCard>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<Layers className="size-7" strokeWidth={1.5} />}
            title={event !== undefined ? "No subfolders yet" : "No events yet"}
            description={
              event !== undefined
                ? isAdmin ? "Create the first subfolder for this event." : "No photo folders have been published for this event yet."
                : isAdmin
                ? "Create one above, then add the photos to it."
                : "Nothing has been published yet. New events will show up here."
            }
          />
        )}
      </section>
      {dialog}
    </AppShell>
  );
}

function useInfinitePhotos(collectionId: string, filename = "") {
  return useInfiniteQuery({
    queryKey: filename ? ["photos", collectionId, "filename", filename] : ["photos", collectionId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.listPhotos(collectionId, pageParam, PHOTO_PAGE_SIZE, filename),
    getNextPageParam: (lastPage) => lastPage.cursor,
    retry: false,
  });
}

function PhotoPageLoader({
  hasNextPage,
  isFetchingNextPage,
  isFetchNextPageError,
  fetchNextPage,
}: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  fetchNextPage: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hasNextPage || isFetchNextPageError) return;
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && !isFetchingNextPage) {
          fetchNextPage();
        }
      },
      { rootMargin: "900px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError]);

  if (!hasNextPage && !isFetchingNextPage) return null;
  return (
    <div ref={ref} className="flex h-24 items-center justify-center text-sm text-muted-foreground">
      {isFetchingNextPage ? (
        <span className="inline-flex items-center gap-2">
          <Loader2 className="size-4 animate-spin" />
          Loading more photos
        </span>
      ) : isFetchNextPageError ? (
        <GlassButton variant="quiet" icon={<RefreshCw className="size-4" />} onClick={fetchNextPage}>
          Retry loading more photos
        </GlassButton>
      ) : (
        <span className="h-6" aria-hidden />
      )}
    </div>
  );
}

function SubfolderDialog({ eventId, compact = false }: { eventId: string; compact?: boolean }) {
  const navigate = Route.useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const create = useMutation({
    mutationFn: () => api.createEventSubfolder(eventId, name.trim(), description.trim() || undefined),
    onSuccess: (folder) => {
      setOpen(false);
      setName("");
      setDescription("");
      for (const key of [["collections"], ["collections", "event", eventId], ["showcase-events"], ["recent-collections"]]) {
        void qc.invalidateQueries({ queryKey: key });
      }
      toast.success("Subfolder created");
      void navigate({ to: ".", search: { event: eventId, shared: folder.id } });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not create the subfolder"),
  });

  return (
    <>
      <GlassButton
        variant={compact ? "quiet" : "primary"}
        size={compact ? "sm" : "md"}
        icon={<FolderPlus className="size-4" />}
        onClick={() => setOpen(true)}
      >
        Add subfolder
      </GlassButton>
      <Dialog open={open} onOpenChange={(next) => { if (!create.isPending) setOpen(next); }}>
        <DialogContent className="w-[calc(100%-2rem)] max-w-md rounded-lg">
          <DialogHeader className="pr-6 text-left">
            <DialogTitle>New event subfolder</DialogTitle>
            <DialogDescription>
              Create a separate photo folder, such as Day 1 or Day 2.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim().length >= 2) create.mutate();
            }}
          >
            <label className="block text-sm">
              <span className="mb-1.5 block text-muted-foreground">Subfolder name</span>
              <input
                autoFocus
                required
                minLength={2}
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Day 1"
                className="h-11 w-full rounded-lg border border-hairline bg-secondary px-3"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1.5 block text-muted-foreground">Description (optional)</span>
              <input
                maxLength={400}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Opening day"
                className="h-11 w-full rounded-lg border border-hairline bg-secondary px-3"
              />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <GlassButton
                type="button"
                variant="ghost"
                disabled={create.isPending}
                onClick={() => setOpen(false)}
              >
                Cancel
              </GlassButton>
              <GlassButton
                type="submit"
                loading={create.isPending}
                disabled={name.trim().length < 2}
                icon={<FolderPlus className="size-4" />}
              >
                Create subfolder
              </GlassButton>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ------------------------------- Admin view ------------------------------- */

function AdminCollection({ collectionId, name, eventId }: { collectionId: string; name: string; eventId?: string }) {
  const { ask, dialog } = useConfirm();
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<BulkProgress | null>(null);
  // Live indexing runs until it is stopped, so it is held as a controller
  // rather than a boolean: closing the tab has to end it too.
  const [watcher, setWatcher] = useState<AbortController | null>(null);
  const [idle, setIdle] = useState<number | null>(null);

  useEffect(() => () => watcher?.abort(), [watcher]);
  const [open, setOpen] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showDuplicates, setShowDuplicates] = useState(false);

  const [filenameDraft, setFilenameDraft] = useState("");
  const [filename, setFilename] = useState("");
  const photos = useInfinitePhotos(collectionId, filename);
  // An empty storage page is not a complete search; continue through every cursor.
  useEffect(() => {
    if (filename && photos.hasNextPage && !photos.isFetching && !photos.isError) void photos.fetchNextPage();
  }, [filename, photos.hasNextPage, photos.isFetching, photos.isError, photos.fetchNextPage]);

  const removeSelected = useMutation({
    // A selection goes to the recycle bin in slices, because moving a photo is
    // several storage calls and a request has a ceiling on those. Every slice
    // after the first joins the entry the first one made, so the whole
    // selection comes back with a single Restore.
    mutationFn: async (ids: string[]) => {
      let deleted = 0;
      let groupId: string | null = null;
      for (let i = 0; i < ids.length; i += MAX_TRASH_PER_REQUEST) {
        const r = await api.deletePhotos(collectionId, ids.slice(i, i + MAX_TRASH_PER_REQUEST), groupId ?? undefined);
        deleted += r.deleted;
        groupId = r.groupId ?? groupId;
      }
      return { deleted, groupId };
    },
    onSuccess: (r) => {
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ["photos", collectionId] });
      qc.invalidateQueries({ queryKey: ["collections"] });
      qc.invalidateQueries({ queryKey: ["bin"] });
      qc.invalidateQueries({ queryKey: ["recent-collections"] });
      const groupId = r.groupId;
      toast.success(`Moved ${formatCount(r.deleted, "photo")} to the recycle bin`, {
        description: "Restore them from the admin console for 30 days.",
        ...(groupId ? { action: { label: "Undo", onClick: () => void undoFromBin(qc, groupId) } } : {}),
      });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not delete those photos"),
  });

  async function upload(list: FileList | null) {
    const files = Array.from(list ?? []).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    try {
      const r = await uploadPhotos({ collectionId, files, onProgress: setProgress });
      const added = r.processed - r.failed;

      if (added === 0) {
        toast.error(r.firstError ?? "No photos could be added");
        return;
      }

      // Detected and indexed are different numbers. Reporting the first as if it
      // were the second is how "7 faces indexed" appeared when none were.
      const faceNote =
        r.faces === 0
          ? "no faces found"
          : r.indexed >= r.faces
            ? `${formatCount(r.faces, "face")} searchable`
            : `${formatCount(r.faces, "face")} found, ${r.indexed} searchable`;
      const failedNote = r.failed > 0 ? ` · ${r.failed} failed` : "";
      toast.success(`Added ${formatCount(added, "photo")} · ${faceNote}${failedNote}`);

      if (r.failed > 0 && r.firstError) toast.error(r.firstError);
      if (r.indexPending > 0) {
        toast.warning(
          `${r.indexPending} photo(s) stored, and their faces kept, but the search ` +
            "index was unreachable so they are not findable yet. Nothing is lost.",
        );
      }
      qc.invalidateQueries({ queryKey: ["photos", collectionId] });
      qc.invalidateQueries({ queryKey: ["collections"] });
      qc.invalidateQueries({ queryKey: ["recent-collections"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setProgress(null);
    }
  }

  /**
   * Watches for photographs the uploader script has pushed up, and indexes
   * them. Runs until it is switched off or the tab is closed.
   */
  function toggleLive() {
    if (watcher) {
      watcher.abort();
      setWatcher(null);
      setProgress(null);
      setIdle(null);
      toast.info("Stopped watching for new photos");
      return;
    }
    const controller = new AbortController();
    setWatcher(controller);
    toast.success("Watching for new photos. Keep this tab open.");
    void keepIndexing({
      collectionId,
      signal: controller.signal,
      onProgress: (p) => {
        setIdle(null);
        setProgress({ ...p });
      },
      onIdle: (indexed) => {
        setProgress(null);
        setIdle(indexed);
        qc.invalidateQueries({ queryKey: ["photos", collectionId] });
      },
    }).catch((e) => {
      if (!controller.signal.aborted) {
        toast.error(e instanceof Error ? e.message : "Stopped watching");
        setWatcher(null);
      }
    });
  }

  /**
   * Reads every photograph in this event again.
   *
   * The photographs are not touched and nothing is re-uploaded; only the face
   * records are rewritten. It runs in this browser, so the tab has to stay
   * open, and it can be left half-done safely: a photograph is described by one
   * model or the other, never by both.
   */
  async function reanalyse() {
    const ok = await ask({
      title: `Read all ${formatCount(list.length, "photo")} again?`,
      body:
        "Every photograph is analysed again with the current recogniser. Nothing is " +
        "uploaded and no photograph changes. Keep this tab open until it finishes.",
      confirmLabel: "Re-analyse",
    });
    if (!ok) return;

    try {
      const r = await reanalyseCollection({
        collectionId,
        onProgress: (p) => setProgress({ ...p }),
      });
      const failedNote = r.failed > 0 ? `, ${r.failed} failed` : "";
      toast.success(
        `Re-analysed ${formatCount(r.processed, "photo")} · ${formatCount(r.faces, "face")} searchable${failedNote}`,
      );
      if (r.firstError) toast.error(r.firstError);
      qc.invalidateQueries({ queryKey: ["photos", collectionId] });
      qc.invalidateQueries({ queryKey: ["collections"] });
      qc.invalidateQueries({ queryKey: ["recent-collections"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not re-analyse this event");
    } finally {
      setProgress(null);
    }
  }

  const photoPages = stablePhotoPages(photos.data?.pages);
  const list = photoPages.flatMap((page) => page.photos);
  const grid: GridPhoto[] = list.map(toGridPhoto);
  // Keep upload groups within their fetched page so appends cannot regroup old tiles.
  const batches = photoPages.flatMap((page) =>
    groupIntoBatches(page.photos).map((batch) => ({
      ...batch,
      key: `${page.key}:${batch.key}`,
      offset: page.offset + batch.offset,
    })),
  );

  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** Selects a whole upload at once, or clears it when it is already selected. */
  const toggleBatch = (ids: string[]) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const everySelected = ids.every((id) => next.has(id));
      for (const id of ids) {
        if (everySelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });

  return (
    <>
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <EventTitle collectionId={collectionId} name={name} />
          <p className="mt-1 text-sm text-muted-foreground">
            {photos.isLoading
              ? "Loading photos"
              : photos.isError
                ? "Photos could not be loaded"
                : photos.hasNextPage
                  ? filename ? "Searching event..." : "Event photos"
                  : filename ? `${formatCount(list.length, "matching photo")}` : formatCount(list.length, "photo")}
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            upload(e.target.files);
            e.target.value = "";
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          {eventId && <SubfolderDialog eventId={eventId} compact />}
          <GlassButton
            variant={showDuplicates ? "quiet" : "ghost"}
            icon={<Copy className="size-4" />}
            onClick={() => setShowDuplicates((v) => !v)}
            disabled={list.length < 2}
          >
            Find duplicates
          </GlassButton>
          {/* Indexing whatever the uploader script pushes up, as it arrives. */}
          <GlassButton
            variant={watcher ? "danger" : "quiet"}
            icon={<Radio className="size-4" />}
            onClick={toggleLive}
          >
            {watcher ? "Stop watching" : "Live indexing"}
          </GlassButton>
          {/* Reading every photograph again with the current recogniser.
              Needed once after the recogniser changes, because a face record
              only means anything to the model that wrote it. */}
          <GlassButton
            variant="quiet"
            icon={<RefreshCw className="size-4" />}
            onClick={reanalyse}
            disabled={!!progress}
          >
            Re-analyse
          </GlassButton>
          <GlassButton
            icon={<ImagePlus className="size-4" />}
            onClick={() => inputRef.current?.click()}
            disabled={!!progress}
          >
            Add photos
          </GlassButton>
        </div>
      </div>

      <form className="mb-6 flex flex-wrap items-center gap-2" onSubmit={(e) => {
        e.preventDefault();
        setSelected(new Set()); setOpen(null); setShowDuplicates(false);
        setFilename(filenameDraft.trim());
      }}>
        <div className="relative min-w-0 flex-1 basis-52">
          <Search className="pointer-events-none absolute left-3 top-3 size-5 text-muted-foreground" />
          <input type="search" aria-label="Search photo filename" placeholder="Photo filename" maxLength={200}
            value={filenameDraft} onChange={(e) => setFilenameDraft(e.target.value)}
            className="h-11 w-full rounded-lg border border-hairline bg-secondary pl-10 pr-3 text-sm" />
        </div>
        <GlassButton type="submit" variant="quiet" icon={<Search className="size-4" />} disabled={!filenameDraft.trim()}>Search</GlassButton>
        {filename && <GlassButton type="button" variant="ghost" icon={<X className="size-4" />} onClick={() => {
          setFilename(""); setFilenameDraft(""); setSelected(new Set()); setOpen(null);
        }}>Clear</GlassButton>}
      </form>
      {filename && photos.hasNextPage && !photos.isError && <p role="status" className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Searching all event photos...
      </p>}

      {/* Appears only with a selection, so the default view stays uncluttered. */}
      {selected.size > 0 && (
        <div className="glass-chrome rise-in sticky top-3 z-10 mb-4 flex items-center justify-between gap-3 rounded-2xl border px-4 py-3">
          <span className="text-sm font-medium">{formatCount(selected.size, "photo")} selected</span>
          <div className="flex items-center gap-2">
            <GlassButton
              variant="ghost"
              size="sm"
              icon={<X className="size-4" />}
              onClick={() => setSelected(new Set())}
            >
              Clear
            </GlassButton>
            {selected.size === 1 && (
              <GlassButton
                variant="ghost"
                size="sm"
                icon={<ImageIcon className="size-4" />}
                onClick={() => {
                  const [photoId] = [...selected];
                  void api
                    .setHomeCover(collectionId, photoId!)
                    .then(() => {
                      qc.invalidateQueries({ queryKey: ["home-cover"] });
                      toast.success("Home cover updated", {
                        description: "It now shows, blurred, behind Open recent events.",
                      });
                    })
                    .catch((e) => toast.error(e instanceof Error ? e.message : "Could not set the cover"));
                }}
              >
                Use as home cover
              </GlassButton>
            )}
            <GlassButton
              variant="danger"
              size="sm"
              icon={<Trash2 className="size-4" />}
              loading={removeSelected.isPending}
              onClick={async () => {
                const ok = await ask({
                  title: `Delete ${formatCount(selected.size, "photo")}?`,
                  body: "They move to the recycle bin. You can restore them from the admin console for 30 days.",
                  confirmLabel: "Move to bin",
                });
                if (ok) removeSelected.mutate([...selected]);
              }}
            >
              Delete
            </GlassButton>
          </div>
        </div>
      )}

      {progress && (
        <div className="mb-6">
          <ScanProgress
            progress={progress}
            title="Indexing photos"
            subtitle={`Analysing ${Math.min(progress.processed + 1, progress.total)} of ${progress.total}`}
          />
        </div>
      )}

      {watcher && idle !== null && (
        <div className="glass-chrome mb-6 flex items-center gap-3 rounded-2xl border px-4 py-3 text-sm">
          <span className="relative flex size-2 shrink-0">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
          </span>
          <span className="text-muted-foreground">
            Watching for new photos · {formatCount(idle, "photo")} indexed so far. Keep this tab open.
          </span>
        </div>
      )}

      {showDuplicates && !photos.isLoading && list.length > 1 && (
        <DuplicatesPanel
          collectionId={collectionId}
          photos={list}
          onClose={() => setShowDuplicates(false)}
          onDelete={(ids) => removeSelected.mutateAsync(ids)}
          deleting={removeSelected.isPending}
        />
      )}

      {photos.isLoading ? (
        <PhotoGridSkeleton />
      ) : photos.isError && !list.length ? (
        // A failed load used to fall through to "No photos yet", which reads as
        // an event that has lost everything. Say what actually happened.
        <EmptyState
          icon={<RefreshCw className="size-7" strokeWidth={1.5} />}
          title="Photos could not be loaded"
          description="Nothing has been deleted. The connection to storage dropped; try again in a moment."
          action={
            <GlassButton variant="quiet" icon={<RefreshCw className="size-4" />} onClick={() => void photos.refetch()}>
              Try again
            </GlassButton>
          }
        />
      ) : filename && photos.hasNextPage && !list.length ? (
        <PhotoGridSkeleton count={4} />
      ) : list.length === 0 && !progress ? (
        <EmptyState
          icon={<ImagePlus className="size-7" strokeWidth={1.5} />}
          title={filename ? "No matching photos" : "No photos yet"}
          description={filename ? `No uploaded filename contains "${filename}".` : "Add photos and every face in them will be indexed for member scans."}
        />
      ) : (
        // Newest first, in the batches they were uploaded in, so a whole upload
        // that turns out to be a duplicate can be selected and removed at once
        // instead of being picked out one photograph at a time.
        <>
          <div className="space-y-10">
            {batches.map((batch) => {
              const ids = batch.photos.map((p) => p.id);
              const everySelected = ids.every((id) => selected.has(id));
              return (
                <section key={batch.key} aria-label={batchTitle(batch)}>
                  <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <h2 className="font-medium tracking-[-0.01em]">{batchTitle(batch)}</h2>
                      <p className="text-xs text-muted-foreground">
                        {formatCount(batch.photos.length, "photo")} uploaded
                      </p>
                    </div>
                    <GlassButton
                      variant={everySelected ? "quiet" : "ghost"}
                      size="sm"
                      icon={<CheckCheck className="size-4" />}
                      onClick={() => toggleBatch(ids)}
                    >
                      {everySelected ? "Deselect batch" : "Select batch"}
                    </GlassButton>
                  </div>
                  <PhotoGrid
                    photos={batch.photos.map(toGridPhoto)}
                    onOpen={(i) => setOpen(batch.offset + i)}
                    selected={selected}
                    onToggleSelect={toggleOne}
                    showFileNames={!!filename}
                  />
                </section>
              );
            })}
          </div>
          <PhotoPageLoader
            hasNextPage={photos.hasNextPage}
            isFetchingNextPage={photos.isFetchingNextPage}
            isFetchNextPageError={photos.isFetchNextPageError}
            fetchNextPage={() => void photos.fetchNextPage()}
          />
        </>
      )}
      {open !== null && (
        <PhotoViewer photos={grid} index={open} onIndexChange={setOpen} onClose={() => setOpen(null)} />
      )}
      {dialog}
    </>
  );
}

/* ------------------------------ Member view ------------------------------- */

function MemberCollection({ collectionId, name }: { collectionId: string; name: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<number | null>(null);
  const [scanning, setScanning] = useState(false);
  // Opening an event shows the event. Finding yourself in it is a thing you
  // then choose to do, from the button in the corner, rather than a wall that
  // stands between a member and the photographs.
  const [view, setView] = useState<"all" | "mine">("all");
  // Raised the first time someone presses Find me without a reference photo.
  const [enrolling, setEnrolling] = useState(false);

  const allPhotos = useInfinitePhotos(collectionId);

  const results = useQuery({
    queryKey: ["scan", collectionId],
    queryFn: () => api.cachedScan(collectionId),
    retry: false,
  });

  async function scan() {
    setScanning(true);
    setView("mine");
    try {
      const r = await api.scan(collectionId);
      qc.setQueryData(["scan", collectionId], r);
      // A lagging index is not the same as no matches, and telling someone
      // they are not in the photos when the index simply has not caught up
      // sends them away for good.
      if (r.hits.length === 0 && r.state && r.state !== "no-match") {
        toast.info(explainEmpty(r));
      } else if (r.hits.length) {
        toast.success(`Found you in ${formatCount(r.hits.length, "photo")}`);
      } else {
        toast.info("No confident matches in this collection");
      }
    } catch (e) {
      // No reference photo yet is not an error, it is the next step. Ask for
      // one here rather than sending the member off to another tab to find a
      // control they have never seen.
      if (e instanceof ApiError && e.code === "no-face") {
        setView("all");
        setEnrolling(true);
      } else {
        toast.error(e instanceof Error ? e.message : "Scan failed");
      }
    } finally {
      setScanning(false);
    }
  }

  const hits: ScanHit[] = results.data?.hits ?? [];
  const photoPages = stablePhotoPages(allPhotos.data?.pages);
  const loadedPhotos = photoPages.flatMap((page) => page.photos);
  const everything: GridPhoto[] = loadedPhotos.map(toGridPhoto);
  const grid: GridPhoto[] = view === "mine" ? hits.map(toGridHit) : everything;
  const hasScanned = (results.data?.scannedAt ?? 0) > 0;

  return (
    <>
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-[-0.03em]">{name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {view === "mine"
              ? hasScanned
                ? `${formatCount(hits.length, "photo")} of you`
                : "Not scanned yet"
              : allPhotos.isLoading
                ? "Loading photos"
                : allPhotos.hasNextPage
                  ? "Photos from this event"
                  : `${formatCount(everything.length, "photo")} from this event`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {view === "mine" && (
            <GlassButton variant="quiet" icon={<Layers className="size-4" />} onClick={() => setView("all")}>
              All photos
            </GlassButton>
          )}
          <GlassButton
            icon={<ScanFace className="size-4" />}
            loading={scanning}
            onClick={() => (hasScanned && view === "all" ? setView("mine") : scan())}
          >
            {hasScanned && view === "all" ? "Find me" : hasScanned ? "Scan again" : "Find me"}
          </GlassButton>
        </div>
      </div>

      {scanning && (
        <div className="mb-6">
          <ScanProgress
            progress={{ processed: 0, total: 1, faces: 0, failed: 0 }}
            title="Looking for you"
            subtitle="Comparing against every face in this collection, including turned-away views"
          />
        </div>
      )}

      {view === "all" ? (
        allPhotos.isLoading ? (
          <PhotoGridSkeleton />
        ) : everything.length === 0 ? (
          <EmptyState
            icon={<Layers className="size-7" strokeWidth={1.5} />}
            title="Nothing here yet"
            description="This event has no photos in it."
          />
        ) : (
          <>
            <PagedPhotoGrid
              pages={photoPages.map((page) => ({ ...page, photos: page.photos.map(toGridPhoto) }))}
              onOpen={setOpen}
            />
            <PhotoPageLoader
              hasNextPage={allPhotos.hasNextPage}
              isFetchingNextPage={allPhotos.isFetchingNextPage}
              isFetchNextPageError={allPhotos.isFetchNextPageError}
              fetchNextPage={() => void allPhotos.fetchNextPage()}
            />
          </>
        )
      ) : results.isLoading ? (
        <PhotoGridSkeleton />
      ) : !hasScanned ? (
        <EmptyState
          icon={<ScanFace className="size-7" strokeWidth={1.5} />}
          title="Find yourself in this event"
          description="We compare against your reference face. Only the photos you appear in are shown."
        />
      ) : hits.length === 0 ? (
        <EmptyState
          icon={<ScanFace className="size-7" strokeWidth={1.5} />}
          title={emptyTitle(results.data)}
          description={results.data ? explainEmpty(results.data) : ""}
          action={
            <GlassButton variant="quiet" icon={<Layers className="size-4" />} onClick={() => setView("all")}>
              See all photos
            </GlassButton>
          }
        />
      ) : (
        <PhotoGrid photos={grid} onOpen={setOpen} showConfidence />
      )}

      {open !== null && (
        <PhotoViewer photos={grid} index={open} onIndexChange={setOpen} onClose={() => setOpen(null)} />
      )}

      {enrolling && (
        <FaceEnrolSheet
          onClose={() => setEnrolling(false)}
          onDone={() => {
            setEnrolling(false);
            void scan();
          }}
        />
      )}
    </>
  );
}

/* ------------------------- explaining an empty result ---------------------- */

/**
 * Says what actually happened.
 *
 * Every empty outcome used to read as "no matches", which is wrong in four of
 * the five cases and sends a member away believing they are not in the photos.
 * The server now reports which case it is, and each one has a different answer
 * and a different person who can act on it.
 */
function emptyTitle(r: ScanResult | undefined): string {
  switch (r?.state) {
    case "empty":
      return "Nothing here yet";
    case "not-processed":
    case "indexing":
      return "Still being prepared";
    case "no-faces":
      return "No faces in these photos";
    default:
      return "Your photos are on their way";
  }
}

function explainEmpty(r: ScanResult): string {
  const n = r.index;
  switch (r.state) {
    case "empty":
      return "This collection has no photos in it yet.";
    case "not-processed":
      return "These photos have not been analysed for faces yet. Ask the team to re-index this collection.";
    case "no-faces":
      return "These photos were analysed and no faces were found in them, so there is nothing to match against.";
    case "indexing":
      return n
        ? `${n.pending} of ${n.withFaces} photo(s) with faces are still being added to the search. Try again in a minute.`
        : "These photos are still being prepared for search. Try again in a minute.";
    default:
      // "No matches here" was the honest reading of the data and the wrong
      // thing to say to a guest at a live event. Most of the time it does not
      // mean they were photographed and missed, it means the photographer has
      // not reached them yet, and the team is told so they can. Telling someone
      // they are not in the photographs, at an event they are standing in, is
      // both discouraging and usually untrue.
      return "The team has not photographed you yet, or your photos are still being uploaded. Do check back a little later.";
  }
}

/* --------------------------------- shared --------------------------------- */

/**
 * Photos uploaded within this long of each other belong to the same batch.
 *
 * An upload, whether a card emptied through the watcher or a selection added on
 * this screen, arrives as a run of photographs seconds apart, and the next one
 * starts after a pause. Five quiet minutes is long enough that one card never
 * splits in two, and short enough that 10:00 and 10:20 stay separate.
 */
const BATCH_GAP_MS = 5 * 60 * 1000;

/** Photos moved to the recycle bin per request. The server accepts no more. */
const MAX_TRASH_PER_REQUEST = 100;

type Batch = { key: string; photos: Photo[]; newest: number; oldest: number; offset: number };

/**
 * Splits a newest-first list wherever the uploads paused, keeping the order.
 * `offset` is where each batch starts in the full list, which is what the photo
 * viewer counts in.
 */
function groupIntoBatches(photos: Photo[]): Batch[] {
  const batches: Batch[] = [];
  photos.forEach((photo, index) => {
    const at = photo.createdAt ?? 0;
    const current = batches[batches.length - 1];
    if (current && current.oldest - at <= BATCH_GAP_MS) {
      current.photos.push(photo);
      current.oldest = at;
    } else {
      batches.push({ key: `${at}-${photo.id}`, photos: [photo], newest: at, oldest: at, offset: index });
    }
  });
  return batches;
}

/** "Today · 10:00 PM to 10:07 PM", or one time when the batch is a single minute. */
function batchTitle(batch: Batch): string {
  if (!batch.newest) return "Earlier uploads";
  const from = timeLabel(batch.oldest);
  const to = timeLabel(batch.newest);
  return `${dayLabel(batch.oldest)} · ${from === to ? from : `${from} to ${to}`}`;
}

/**
 * The event's name, with a pencil to rename it. Operators only: this sits in
 * the admin view of an event, and the server refuses anyone else.
 */
function EventTitle({ collectionId, name }: { collectionId: string; name: string }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);

  const rename = useMutation({
    mutationFn: (next: string) => api.renameCollection(collectionId, next),
    onSuccess: (r) => {
      toast.success(`Renamed to "${r.name}"`);
      setEditing(false);
      qc.invalidateQueries({ queryKey: ["collections"] });
      qc.invalidateQueries({ queryKey: ["showcase-events"] });
      qc.invalidateQueries({ queryKey: ["recent-collections"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not rename the event"),
  });

  if (!editing) {
    return (
      <div className="flex items-center gap-2">
        <h1 className="text-3xl font-semibold tracking-[-0.03em]">{name}</h1>
        <button
          type="button"
          aria-label="Rename event"
          onClick={() => {
            setDraft(name);
            setEditing(true);
          }}
          className="press flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Pencil className="size-4" />
        </button>
      </div>
    );
  }

  const trimmed = draft.trim();
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (trimmed.length >= 2 && trimmed !== name) rename.mutate(trimmed);
        else setEditing(false);
      }}
    >
      <input
        autoFocus
        aria-label="Event name"
        value={draft}
        maxLength={120}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setEditing(false);
        }}
        className="h-12 w-full max-w-md rounded-2xl border border-hairline bg-background/60 px-4 text-xl font-semibold outline-none focus:ring-2 focus:ring-ring"
      />
      <GlassButton type="submit" size="sm" icon={<Check className="size-4" />} loading={rename.isPending} disabled={trimmed.length < 2}>
        Save
      </GlassButton>
      <GlassButton type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
        Cancel
      </GlassButton>
    </form>
  );
}

/** The Undo on a delete toast: puts the whole entry straight back. */
async function undoFromBin(qc: QueryClient, groupId: string) {
  try {
    const r = await api.restoreFromBin(groupId);
    toast.success(`Restored ${formatCount(r.restored, "photo")}`);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Could not restore");
  } finally {
    for (const queryKey of [["collections"], ["bin"], ["photos"], ["showcase-events"], ["recent-collections"], ["export-collections"]]) qc.invalidateQueries({ queryKey });
  }
}

const toGridPhoto = (p: Photo): GridPhoto => ({
  id: p.id,
  thumbUrl: p.thumbUrl,
  fullUrl: p.fullUrl,
  width: p.width,
  height: p.height,
  fileName: p.fileName,
});

const toGridHit = (h: ScanHit): GridPhoto => ({
  id: h.photoId,
  thumbUrl: h.thumbUrl,
  fullUrl: h.fullUrl,
  width: h.width,
  height: h.height,
  fileName: h.fileName,
  confidence: h.confidence,
});

export { confidencePercent };
