import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ImagePlus, Layers, Plus, ScanFace, Trash2 } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { ScanProgress } from "@/components/ScanProgress";
import { PhotoGrid, usePhotoUrls } from "@/components/PhotoGrid";
import { PhotoViewer } from "@/components/PhotoViewer";
import { EmptyState, GlassButton, GlassCard, Shimmer } from "@/components/ui-kit";
import { supabase } from "@/integrations/supabase/client";
import { useRequireAuth } from "@/lib/auth-gate";
import { scanSharedCollection, NoFaceProfileError, type ScanProgress as ScanState } from "@/lib/scan";
import { formatCount } from "@/lib/images";
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
  return <Collections userId={user.id} isAdmin={!!isAdmin.data} />;
}

function Collections({ userId, isAdmin }: { userId: string; isAdmin: boolean }) {
  const { shared } = Route.useSearch();
  const navigate = Route.useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);

  const sharedCollections = useQuery({
    queryKey: ["shared-collections"],
    queryFn: async () => {
      const { data } = await supabase
        .from("shared_collections")
        .select("id, name, description, cover_path, created_at, shared_photos(count)")
        .order("created_at", { ascending: false });
      return data ?? [];
    },
  });
  const covers = usePhotoUrls(
    (sharedCollections.data ?? []).filter((c) => c.cover_path).map((c) => ({ storage_path: c.cover_path! })),
  );

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    const { data, error } = await supabase
      .from("shared_collections")
      .insert({ name: name.trim(), description: description.trim() || null, created_by: userId })
      .select("id")
      .single();
    setCreating(false);
    if (error || !data) {
      toast.error(error?.message ?? "Could not create the collection");
      return;
    }
    setName("");
    setDescription("");
    await qc.invalidateQueries({ queryKey: ["shared-collections"] });
    navigate({ to: ".", search: { shared: data.id } });
  }

  async function remove(cid: string) {
    if (!confirm("Delete this collection and all its photos?")) return;
    const { data: photos } = await supabase.from("shared_photos").select("storage_path").eq("collection_id", cid);
    const paths = (photos ?? []).map((p) => p.storage_path);
    for (let i = 0; i < paths.length; i += 100) await supabase.storage.from("photos").remove(paths.slice(i, i + 100));
    const { error } = await supabase.from("shared_collections").delete().eq("id", cid);
    if (error) {
      toast.error(error.message);
      return;
    }
    qc.invalidateQueries({ queryKey: ["shared-collections"] });
  }

  if (shared) {
    const current = sharedCollections.data?.find((c) => c.id === shared);
    return (
      <AppShell wide>
        <button
          onClick={() => navigate({ to: ".", search: { shared: undefined } })}
          className="press mb-5 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" /> Collections
        </button>
        {isAdmin ? (
          <AdminCollection
            userId={userId}
            collectionId={shared}
            name={current?.name ?? "Collection"}
            description={current?.description}
          />
        ) : (
          <MemberCollection
            userId={userId}
            collectionId={shared}
            name={current?.name ?? "Collection"}
            description={current?.description}
          />
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
        <form onSubmit={create} className="mt-7 space-y-2.5">
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
            <GlassButton type="submit" icon={<Plus className="size-4" />} loading={creating} disabled={!name.trim()}>
              New collection
            </GlassButton>
          </div>
        </form>
      )}

      <section className="mt-9">
        {sharedCollections.isLoading ? (
          <Shimmer className="h-40" />
        ) : sharedCollections.data?.length ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {sharedCollections.data.map((c) => (
              <GlassCard
                key={c.id}
                interactive
                aria-label={`Open ${c.name}`}
                onClick={() => navigate({ to: ".", search: { shared: c.id } })}
                className="group overflow-hidden"
              >
                <div className="aspect-[16/10] overflow-hidden bg-secondary">
                  {c.cover_path && covers[c.cover_path] && (
                    <img
                      src={covers[c.cover_path]}
                      alt=""
                      className="fade-in size-full object-cover transition duration-700 group-hover:scale-[1.03]"
                    />
                  )}
                </div>
                <div className="flex items-center justify-between gap-3 px-5 py-4">
                  <div className="min-w-0">
                    <p className="truncate font-medium tracking-[-0.01em]">{c.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {formatCount(c.shared_photos?.[0]?.count ?? 0, "photo")}
                      {c.description ? ` · ${c.description}` : ""}
                    </p>
                  </div>
                  {isAdmin && (
                    <button
                      aria-label={`Delete ${c.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        remove(c.id);
                      }}
                      className="press rounded-full p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
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
            title={isAdmin ? "No collections yet" : "Nothing shared yet"}
            description={
              isAdmin
                ? "Name your first collection above, then add the photos to it."
                : "Check back once the organisers publish a collection."
            }
          />
        )}
      </section>
    </AppShell>
  );
}

/* ------------------------------ Admin view ------------------------------ */

function AdminCollection({
  userId,
  collectionId,
  name,
  description,
}: {
  userId: string;
  collectionId: string;
  name: string;
  description?: string | null | undefined;
}) {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<BulkProgress | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  const photos = useQuery({
    queryKey: ["shared-photos", collectionId],
    queryFn: async () => {
      const { data } = await supabase
        .from("shared_photos")
        .select("id, storage_path, file_name, width, height, faces_count")
        .eq("collection_id", collectionId)
        .order("created_at", { ascending: false });
      return data ?? [];
    },
  });

  async function upload(list: FileList | null) {
    const files = Array.from(list ?? []).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    try {
      const r = await uploadPhotos({ collectionId, files, onProgress: setProgress });
      const added = r.processed - r.failed;

      // Nothing added means every photo was refused for the same reason. Saying
      // "added 0 photos" without it reads like success over an empty folder.
      if (added === 0) {
        toast.error(r.firstError ?? "No photos could be added");
        return;
      }

      const saved = uploadSavings(r);
      const savedNote = r.bytesIn > 0 && saved > 0 ? ` · ${saved}% smaller` : "";
      const failedNote = r.failed > 0 ? ` · ${r.failed} failed` : "";
      toast.success(
        `Added ${formatCount(added, "photo")} · ${formatCount(r.faces, "face")} indexed${savedNote}${failedNote}`,
      );
      if (r.failed > 0 && r.firstError) toast.error(r.firstError);
      if (r.indexPending > 0) {
        toast.warning(`${r.indexPending} photo(s) stored but not searchable yet: the face index is unavailable.`);
      }
      qc.invalidateQueries({ queryKey: ["shared-photos", collectionId] });
      qc.invalidateQueries({ queryKey: ["shared-collections"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setProgress(null);
    }
  }

  const list = photos.data ?? [];

  return (
    <>
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-[-0.03em]">{name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatCount(list.length, "photo")}
            {description ? ` · ${description}` : ""}
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
        <GlassButton icon={<ImagePlus className="size-4" />} onClick={() => inputRef.current?.click()} disabled={!!progress}>
          Add photos
        </GlassButton>
      </div>

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
        <Shimmer className="h-64" />
      ) : list.length === 0 && !progress ? (
        <EmptyState
          icon={<ImagePlus className="size-7" strokeWidth={1.5} />}
          title="No photos yet"
          description="Add photos and every face in them is indexed, ready for member scans."
        />
      ) : (
        <PhotoGrid photos={list} onOpen={setOpen} />
      )}
      {open !== null && <PhotoViewer photos={list} index={open} onIndexChange={setOpen} onClose={() => setOpen(null)} />}
    </>
  );
}

/* ------------------------------ Member view ----------------------------- */

function MemberCollection({
  userId,
  collectionId,
  name,
  description,
}: {
  userId: string;
  collectionId: string;
  name: string;
  description?: string | null | undefined;
}) {
  const qc = useQueryClient();
  const [progress, setProgress] = useState<ScanState | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [scanComplete, setScanComplete] = useState(false);

  const profile = useQuery({
    queryKey: ["face-profile", userId],
    queryFn: async () => {
      const { data } = await supabase.from("face_profiles").select("id").eq("user_id", userId).maybeSingle();
      return data ?? null;
    },
  });

  const matches = useQuery({
    queryKey: ["scan-results", userId, collectionId],
    queryFn: async () => {
      const { data } = await supabase
        .from("scan_results")
        .select("similarity, created_at, shared_photos(id, storage_path, file_name, width, height, faces_count)")
        .eq("user_id", userId)
        .eq("collection_id", collectionId)
        .order("similarity", { ascending: false });
      return (data ?? [])
        .filter((r) => r.shared_photos)
        .map((r) => ({ ...r.shared_photos!, best_similarity: r.similarity, scanned_at: r.created_at }));
    },
  });

  async function scan() {
    setScanComplete(false);
    setProgress({ processed: 0, total: 0, matches: 0, faces: 0, failed: 0 });
    try {
      const r = await scanSharedCollection({ userId, collectionId, onProgress: setProgress });

      if (!r.matched) {
        toast.info("No confident matches in this collection");
      } else {
        // Say plainly when angles were recovered, because that is the part a
        // member would otherwise assume was missing.
        const extra = r.linkedFaces > 0 ? `, ${r.linkedFaces} at other angles` : "";
        toast.success(`Found you in ${formatCount(r.matched, "photo")}${extra}`);
      }

      setScanComplete(true);
      qc.invalidateQueries({ queryKey: ["scan-results", userId, collectionId] });
      qc.invalidateQueries({ queryKey: ["my-shared-matches", userId] });
    } catch (e) {
      if (e instanceof NoFaceProfileError) {
        toast.error(e.message);
      } else {
        toast.error(
          e instanceof Error
            ? e.message
            : typeof e === "object" && e && "message" in e
              ? String((e as { message: unknown }).message)
              : "Scan failed",
        );
      }
    } finally {
      setProgress(null);
    }
  }

  const hasScanned = scanComplete || (matches.data?.length ?? 0) > 0;
  const list = matches.data ?? [];

  return (
    <>
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-[-0.03em]">{name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {hasScanned ? `${formatCount(list.length, "photo")} of you` : "Not scanned yet"}
            {description ? ` · ${description}` : ""}
          </p>
        </div>
        {profile.data ? (
          <GlassButton icon={<ScanFace className="size-4" />} loading={!!progress} onClick={scan}>
            {progress ? "Scanning…" : hasScanned ? "Scan again" : "Find me"}
          </GlassButton>
        ) : (
          <Link to="/home">
            <GlassButton icon={<ScanFace className="size-4" />}>Add your face to scan</GlassButton>
          </Link>
        )}
      </div>

      {progress ? (
        <ScanProgress progress={progress} />
      ) : matches.isLoading ? (
        <Shimmer className="h-64" />
      ) : list.length === 0 ? (
        <EmptyState
          icon={<ScanFace className="size-7" strokeWidth={1.5} />}
          title={hasScanned ? "No photos of you here" : "Ready when you are"}
          description={
            profile.data
              ? "Tap “Find me” — only photos that confidently match your reference face will appear."
              : "Add a reference photo of yourself on Home first — it's analysed privately on your device."
          }
        />
      ) : (
        <PhotoGrid photos={list} onOpen={setOpen} />
      )}
      {open !== null && <PhotoViewer photos={list} index={open} onIndexChange={setOpen} onClose={() => setOpen(null)} />}
    </>
  );
}
