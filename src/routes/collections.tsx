import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ImagePlus, Layers, Plus, ScanFace, Trash2, X } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { ScanProgress } from "@/components/ScanProgress";
import { PhotoGrid, PhotoGridSkeleton, type GridPhoto } from "@/components/PhotoGrid";
import { PhotoViewer } from "@/components/PhotoViewer";
import { EmptyState, GlassButton, GlassCard, Shimmer } from "@/components/ui-kit";
import { useRequireAuth } from "@/lib/auth-gate";
import { formatCount } from "@/lib/images";
import { api, ApiError, confidencePercent, type Photo, type ScanHit } from "@/lib/api";
import { uploadPhotos, uploadSavings, type BulkProgress } from "@/lib/upload";
import { useIsAdmin } from "@/lib/roles";

export const Route = createFileRoute("/collections")({
  validateSearch: (s: Record<string, unknown>) => ({
    shared: typeof s["shared"] === "string" ? s["shared"] : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Collections — VAYAM Designers Gallery" },
      { name: "description", content: "Browse shared photo collections and find yourself in them." },
      { property: "og:title", content: "Collections — VAYAM Designers Gallery" },
      { property: "og:description", content: "Browse shared photo collections and find yourself in them." },
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
  const { shared } = Route.useSearch();
  const navigate = Route.useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const collections = useQuery({
    queryKey: ["collections"],
    queryFn: api.listCollections,
    retry: false,
  });

  const create = useMutation({
    mutationFn: () => api.createCollection(name.trim(), description.trim() || undefined),
    onSuccess: (created) => {
      setName("");
      setDescription("");
      qc.invalidateQueries({ queryKey: ["collections"] });
      navigate({ to: ".", search: { shared: created.id } });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not create the collection"),
  });

  const remove = useMutation({
    mutationFn: (cid: string) => api.deletePhotos(cid),
    onSuccess: (r) => {
      toast.success(`Collection deleted, ${formatCount(r.deleted, "photo")} removed`);
      qc.invalidateQueries({ queryKey: ["collections"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not delete the collection"),
  });

  if (shared) {
    const current = collections.data?.find((c) => c.id === shared);
    return (
      <AppShell wide>
        <button
          onClick={() => navigate({ to: ".", search: { shared: undefined } })}
          className="press mb-5 inline-flex items-center gap-1 rounded-full text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronLeft className="size-4" /> Collections
        </button>
        {isAdmin ? (
          <AdminCollection collectionId={shared} name={current?.name ?? "Collection"} />
        ) : (
          <MemberCollection collectionId={shared} name={current?.name ?? "Collection"} />
        )}
      </AppShell>
    );
  }

  const input =
    "h-12 w-full rounded-2xl border border-hairline bg-background/60 px-5 text-sm outline-none transition focus:ring-2 focus:ring-ring";

  return (
    <AppShell>
      <h1 className="text-3xl font-semibold tracking-[-0.03em]">Collections</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {isAdmin
          ? "Create a collection, then add the photos to it. Every face is indexed once so members can find themselves."
          : "Open a collection and tap Find me — only the photos that match your reference face appear."}
      </p>

      {isAdmin && (
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
            placeholder="Collection name — e.g. Brand Summit 2026"
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
              New collection
            </GlassButton>
          </div>
        </form>
      )}

      <section className="mt-9">
        {collections.isLoading ? (
          <Shimmer className="h-40" />
        ) : collections.isError ? (
          <EmptyState
            tone="error"
            icon={<Layers className="size-7" strokeWidth={1.5} />}
            title="Collections unavailable"
            description={
              collections.error instanceof Error ? collections.error.message : "Could not load collections."
            }
          />
        ) : collections.data?.length ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {collections.data.map((c) => (
              <GlassCard
                key={c.id}
                interactive
                aria-label={`Open ${c.name}`}
                onClick={() => navigate({ to: ".", search: { shared: c.id } })}
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
                      onClick={(e) => {
                        e.stopPropagation();
                        if (
                          confirm(
                            `Delete "${c.name}" and all ${c.photoCount} photo(s)? This cannot be undone.`,
                          )
                        ) {
                          remove.mutate(c.id);
                        }
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
            title="No collections yet"
            description={
              isAdmin
                ? "Create one above, then add the photos to it."
                : "Nothing has been published yet. New collections will show up here."
            }
          />
        )}
      </section>
    </AppShell>
  );
}

/* ------------------------------- Admin view ------------------------------- */

function AdminCollection({ collectionId, name }: { collectionId: string; name: string }) {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<BulkProgress | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const photos = useQuery({
    queryKey: ["photos", collectionId],
    queryFn: () => api.allPhotos(collectionId),
    retry: false,
  });

  const removeSelected = useMutation({
    mutationFn: (ids: string[]) => api.deletePhotos(collectionId, ids),
    onSuccess: (r) => {
      toast.success(`Deleted ${formatCount(r.deleted, "photo")}`);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ["photos", collectionId] });
      qc.invalidateQueries({ queryKey: ["collections"] });
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
      const saved = uploadSavings(r);
      const savedNote = r.bytesIn > 0 && saved > 0 ? ` · saved ${saved}% storage` : "";
      const failedNote = r.failed > 0 ? ` · ${r.failed} failed` : "";
      toast.success(`Added ${formatCount(added, "photo")} · ${faceNote}${savedNote}${failedNote}`);

      if (r.failed > 0 && r.firstError) toast.error(r.firstError);
      if (r.indexPending > 0) {
        toast.warning(
          `${r.indexPending} photo(s) stored, and their faces kept, but the search ` +
            "index was unreachable so they are not findable yet. Nothing is lost.",
        );
      }
      qc.invalidateQueries({ queryKey: ["photos", collectionId] });
      qc.invalidateQueries({ queryKey: ["collections"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setProgress(null);
    }
  }

  const list = photos.data ?? [];
  const grid: GridPhoto[] = list.map(toGridPhoto);

  return (
    <>
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-[-0.03em]">{name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{formatCount(list.length, "photo")}</p>
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
        <GlassButton
          icon={<ImagePlus className="size-4" />}
          onClick={() => inputRef.current?.click()}
          disabled={!!progress}
        >
          Add photos
        </GlassButton>
      </div>

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
            <GlassButton
              variant="danger"
              size="sm"
              icon={<Trash2 className="size-4" />}
              loading={removeSelected.isPending}
              onClick={() => {
                if (confirm(`Delete ${selected.size} photo(s)? This cannot be undone.`)) {
                  removeSelected.mutate([...selected]);
                }
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

      {photos.isLoading ? (
        <PhotoGridSkeleton />
      ) : list.length === 0 && !progress ? (
        <EmptyState
          icon={<ImagePlus className="size-7" strokeWidth={1.5} />}
          title="No photos yet"
          description="Add photos and every face in them will be indexed for member scans."
        />
      ) : (
        <PhotoGrid
          photos={grid}
          onOpen={setOpen}
          selected={selected}
          onToggleSelect={(id) =>
            setSelected((prev) => {
              const next = new Set(prev);
              next.has(id) ? next.delete(id) : next.add(id);
              return next;
            })
          }
        />
      )}
      {open !== null && (
        <PhotoViewer photos={grid} index={open} onIndexChange={setOpen} onClose={() => setOpen(null)} />
      )}
    </>
  );
}

/* ------------------------------ Member view ------------------------------- */

function MemberCollection({ collectionId, name }: { collectionId: string; name: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<number | null>(null);
  const [showPossible, setShowPossible] = useState(false);
  const [scanning, setScanning] = useState(false);

  const results = useQuery({
    queryKey: ["scan", collectionId],
    queryFn: () => api.cachedScan(collectionId),
    retry: false,
  });

  async function scan() {
    setScanning(true);
    try {
      const r = await api.scan(collectionId);
      qc.setQueryData(["scan", collectionId], r);
      // A lagging index is not the same as no matches, and telling someone
      // they are not in the photos when the index simply has not caught up
      // sends them away for good.
      if (r.indexLagging) {
        toast.info("These photos are still being indexed. Try again in a minute.");
      } else if (r.hits.length) {
        toast.success(
          `Found you in ${formatCount(r.hits.length, "photo")}` +
            (r.possible.length ? `, plus ${r.possible.length} to check` : ""),
        );
      } else {
        toast.info("No confident matches in this collection");
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === "no-face") {
        toast.error("Add a reference photo of yourself first, from the Home tab.");
      } else {
        toast.error(e instanceof Error ? e.message : "Scan failed");
      }
    } finally {
      setScanning(false);
    }
  }

  const hits = results.data?.hits ?? [];
  const possible = results.data?.possible ?? [];
  const shown: ScanHit[] = showPossible ? [...hits, ...possible] : hits;
  const grid: GridPhoto[] = shown.map(toGridHit);
  const hasScanned = (results.data?.scannedAt ?? 0) > 0;

  return (
    <>
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-[-0.03em]">{name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {hasScanned ? `${formatCount(hits.length, "photo")} of you` : "Not scanned yet"}
          </p>
        </div>
        <GlassButton icon={<ScanFace className="size-4" />} loading={scanning} onClick={scan}>
          {hasScanned ? "Scan again" : "Find me"}
        </GlassButton>
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

      {results.isLoading ? (
        <PhotoGridSkeleton />
      ) : !hasScanned ? (
        <EmptyState
          icon={<ScanFace className="size-7" strokeWidth={1.5} />}
          title="Find yourself in this collection"
          description="We compare against your reference face on your device. Only the photos you appear in are shown."
        />
      ) : hits.length === 0 && possible.length === 0 ? (
        <EmptyState
          icon={<ScanFace className="size-7" strokeWidth={1.5} />}
          title={results.data?.indexLagging ? "Still indexing" : "No matches here"}
          description={
            results.data?.indexLagging
              ? "These photos were added recently and are still being prepared for search. Try again in a minute."
              : "You do not appear in this collection, or the photos of you are too small or turned too far away to recognise."
          }
        />
      ) : (
        <>
          {possible.length > 0 && (
            <button
              onClick={() => setShowPossible((v) => !v)}
              className="press mb-4 inline-flex items-center gap-2 rounded-full border border-hairline px-4 py-2 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {showPossible ? "Hide" : "Show"} {possible.length} possible match
              {possible.length === 1 ? "" : "es"}
              <span className="text-xs">
                {showPossible ? "" : "· less certain, worth a look"}
              </span>
            </button>
          )}
          <PhotoGrid photos={grid} onOpen={setOpen} showConfidence />
        </>
      )}

      {open !== null && (
        <PhotoViewer photos={grid} index={open} onIndexChange={setOpen} onClose={() => setOpen(null)} />
      )}
    </>
  );
}

/* --------------------------------- shared --------------------------------- */

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
