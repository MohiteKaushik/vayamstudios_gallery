import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ImagePlus, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { ScanProgress } from "@/components/ScanProgress";
import { PhotoGrid } from "@/components/PhotoGrid";
import { PhotoViewer } from "@/components/PhotoViewer";
import { EmptyState, GlassButton, GlassCard, Shimmer } from "@/components/ui-kit";
import { supabase } from "@/integrations/supabase/client";
import { useRequireAuth } from "@/lib/auth-gate";
import { formatCount } from "@/lib/images";
import { uploadPhotos, uploadSavings, type BulkProgress } from "@/lib/upload";
import { useIsAdmin } from "@/lib/roles";

export const Route = createFileRoute("/admin")({
  validateSearch: (s: Record<string, unknown>) => ({
    id: typeof s["id"] === "string" ? s["id"] : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Admin — VAYAM Designers Gallery" },
      { name: "description", content: "Publish photo collections that members can scan for themselves." },
      { property: "og:title", content: "Admin — VAYAM Designers Gallery" },
      { property: "og:description", content: "Publish photo collections that members can scan for themselves." },
    ],
  }),
  component: AdminPage,
});

function AdminPage() {
  const { user } = useRequireAuth();
  const isAdmin = useIsAdmin(user?.id);
  if (!user || isAdmin.isLoading) return null;
  if (!isAdmin.data) {
    return (
      <AppShell>
        <EmptyState
          icon={<ShieldCheck className="size-7" strokeWidth={1.5} />}
          title="Admins only"
          description="This area is for publishing shared collections. Ask an administrator to grant you access."
        />
      </AppShell>
    );
  }
  return <Admin userId={user.id} />;
}

function Admin({ userId }: { userId: string }) {
  const { id } = Route.useSearch();
  const navigate = Route.useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const collections = useQuery({
    queryKey: ["shared-collections"],
    queryFn: async () => {
      const { data } = await supabase
        .from("shared_collections")
        .select("id, name, description, cover_path, created_at, shared_photos(count)")
        .order("created_at", { ascending: false });
      return data ?? [];
    },
  });

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    const { data, error } = await supabase
      .from("shared_collections")
      .insert({ name: name.trim(), description: description.trim() || null, created_by: userId })
      .select("id")
      .single();
    if (error) {
      toast.error(error.message);
      return;
    }
    setName("");
    setDescription("");
    qc.invalidateQueries({ queryKey: ["shared-collections"] });
    navigate({ to: ".", search: { id: data.id } });
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

  if (id) {
    const current = collections.data?.find((c) => c.id === id);
    return (
      <AppShell wide>
        <button
          onClick={() => navigate({ to: ".", search: { id: undefined } })}
          className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" /> All collections
        </button>
        <CollectionEditor userId={userId} collectionId={id} name={current?.name ?? "Collection"} />
      </AppShell>
    );
  }

  const input =
    "h-11 w-full rounded-full border border-hairline bg-background/60 px-5 text-sm outline-none focus:ring-2 focus:ring-ring";

  return (
    <AppShell>
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-5 text-muted-foreground" strokeWidth={1.6} />
        <h1 className="text-3xl font-semibold tracking-[-0.03em]">Shared collections</h1>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        Photos you publish here are indexed for faces once, then any member can scan them for themselves.
      </p>

      <form onSubmit={create} className="mt-6 space-y-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Collection name (e.g. Summer Gala 2026)" className={input} />
        <div className="flex gap-2">
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Short description (optional)" className={input} />
          <GlassButton type="submit" icon={<Plus className="size-4" />} disabled={!name.trim()}>
            Create
          </GlassButton>
        </div>
      </form>

      <div className="mt-8 space-y-2">
        {collections.isLoading ? (
          <Shimmer className="h-16" />
        ) : collections.data?.length ? (
          collections.data.map((c) => (
            <GlassCard
              key={c.id}
              interactive
              onClick={() => navigate({ to: ".", search: { id: c.id } })}
              className="flex items-center justify-between px-5 py-4"
            >
              <div>
                <p className="font-medium tracking-[-0.01em]">{c.name}</p>
                <p className="text-xs text-muted-foreground">{formatCount(c.shared_photos?.[0]?.count ?? 0, "photo")}</p>
              </div>
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
            </GlassCard>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">No shared collections yet.</p>
        )}
      </div>
    </AppShell>
  );
}

function CollectionEditor({ userId, collectionId, name }: { userId: string; collectionId: string; name: string }) {
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
      // Report what the re-encode saved, so the storage bill stays visible.
      const saved = uploadSavings(r);
      const savedNote = r.bytesIn > 0 && saved > 0 ? ` · ${saved}% smaller` : "";
      toast.success(
        `Added ${formatCount(r.processed - r.failed, "photo")} · ${formatCount(r.faces, "face")} indexed${savedNote}`,
      );
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
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
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
          description="Add photos and every face in them will be indexed for member scans."
        />
      ) : (
        <PhotoGrid photos={list} onOpen={setOpen} />
      )}
      {open !== null && <PhotoViewer photos={list} index={open} onIndexChange={setOpen} onClose={() => setOpen(null)} />}
    </>
  );
}
