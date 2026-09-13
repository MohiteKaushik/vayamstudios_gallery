import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Images, RotateCcw, Trash2, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PhotoGrid } from "@/components/PhotoGrid";
import { EmptyState, GlassButton, GlassCard, Shimmer, useConfirm } from "@/components/ui-kit";
import { api, type BinEntry } from "@/lib/api";
import { formatCount } from "@/lib/images";
import { sinceText } from "@/lib/time";

/**
 * The recycle bin, in the admin console only.
 *
 * Deleting photos or an event puts them here instead of erasing them. An
 * operator who removed a batch and later spots good photographs in it can bring
 * back the whole batch, or open it and pick out just the ones worth keeping.
 * Anything left here is cleared for good thirty days after it was deleted.
 */
export function RecycleBinPanel() {
  const { ask, dialog } = useConfirm();
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);

  const bin = useQuery({ queryKey: ["bin"], queryFn: api.listBin, retry: false });

  // Anything that changes the bin can change an event's photos and counts too.
  const refresh = () => {
    for (const queryKey of [["bin"], ["collections"], ["photos"]]) qc.invalidateQueries({ queryKey });
  };

  const restore = useMutation({
    mutationFn: (v: { id: string; photos?: string[] }) => api.restoreFromBin(v.id, v.photos),
    onSuccess: (r) => {
      toast.success(`Restored ${formatCount(r.restored, "photo")}`);
      if (r.remaining === 0) setOpenId(null);
      refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not restore"),
  });

  const purge = useMutation({
    mutationFn: (v: { id: string; photos?: string[] }) => api.deleteFromBin(v.id, v.photos),
    onSuccess: (r) => {
      toast.success(`Deleted ${formatCount(r.deleted, "photo")} for good`);
      if (r.remaining === 0) setOpenId(null);
      refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not delete"),
  });

  const confirmPurge = async (group: BinEntry, photos?: string[]) => {
    const count = photos?.length ?? (group.kind === "event" ? group.photoCount : group.photoIds.length);
    const ok = await ask({
      title:
        group.kind === "event" && !photos
          ? `Delete "${group.collectionName}" for good?`
          : `Delete ${formatCount(count, "photo")} for good?`,
      body: "They cannot be brought back after this.",
      confirmLabel: "Delete forever",
    });
    if (ok) purge.mutate({ id: group.id, ...(photos ? { photos } : {}) });
  };

  const groups = bin.data ?? [];

  return (
    <section className="mt-12">
      <div className="mb-4">
        <h2 className="text-sm font-medium uppercase tracking-[0.12em] text-muted-foreground">
          Recycle bin
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Deleted photos and events wait here for 30 days, then they are cleared for good.
        </p>
      </div>

      {bin.isLoading ? (
        <Shimmer className="h-24" />
      ) : groups.length === 0 ? (
        <EmptyState
          icon={<Trash2 className="size-7" strokeWidth={1.5} />}
          title="The recycle bin is empty"
          description="When you delete photos or an event, they stay here for 30 days in case you need them back."
        />
      ) : (
        <ul className="space-y-2">
          {groups.map((group) => (
            <li key={group.id}>
              <BinCard
                group={group}
                expanded={openId === group.id}
                busy={
                  (restore.isPending && restore.variables?.id === group.id) ||
                  (purge.isPending && purge.variables?.id === group.id)
                }
                onToggle={() => setOpenId((id) => (id === group.id ? null : group.id))}
                onRestore={(photos) => restore.mutate({ id: group.id, ...(photos ? { photos } : {}) })}
                onPurge={(photos) => void confirmPurge(group, photos)}
              />
            </li>
          ))}
        </ul>
      )}
      {dialog}
    </section>
  );
}

function daysLeft(expiresAt: number, now = Date.now()): string {
  const days = Math.ceil((expiresAt - now) / 86_400_000);
  if (days <= 0) return "cleared today";
  return `cleared in ${days} day${days === 1 ? "" : "s"}`;
}

function BinCard({
  group,
  expanded,
  busy,
  onToggle,
  onRestore,
  onPurge,
}: {
  group: BinEntry;
  expanded: boolean;
  busy: boolean;
  onToggle: () => void;
  onRestore: (photos?: string[]) => void;
  onPurge: (photos?: string[]) => void;
}) {
  const isEvent = group.kind === "event";
  const count = isEvent ? group.photoCount : group.photoIds.length;
  const preview = group.preview ?? [];

  return (
    <GlassCard className="px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium tracking-[-0.01em]">
            {isEvent
              ? `Event: ${group.collectionName}`
              : `${formatCount(count, "photo")} from ${group.collectionName}`}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3" />
              Deleted {sinceText(group.deletedAt)}
            </span>
            <span>·</span>
            <span>{daysLeft(group.expiresAt)}</span>
            {isEvent && (
              <>
                <span>·</span>
                <span>{formatCount(count, "photo")}</span>
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!isEvent && (
            <GlassButton
              variant="ghost"
              size="sm"
              icon={expanded ? <X className="size-4" /> : <Images className="size-4" />}
              onClick={onToggle}
            >
              {expanded ? "Close" : "Choose photos"}
            </GlassButton>
          )}
          <GlassButton
            variant="quiet"
            size="sm"
            icon={<RotateCcw className="size-4" />}
            loading={busy}
            onClick={() => onRestore()}
          >
            {isEvent ? "Restore event" : "Restore all"}
          </GlassButton>
          <GlassButton
            variant="danger"
            size="sm"
            icon={<Trash2 className="size-4" />}
            disabled={busy}
            onClick={() => onPurge()}
          >
            Delete forever
          </GlassButton>
        </div>
      </div>

      {!expanded && preview.length > 0 && (
        <div className="mt-3 flex gap-2 overflow-hidden">
          {preview.slice(0, 8).map((p) => (
            <img
              key={p.id}
              src={p.thumbUrl}
              alt={p.fileName}
              loading="lazy"
              className="size-14 shrink-0 rounded-xl bg-secondary object-cover"
            />
          ))}
          {count > 8 && (
            <span className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-secondary text-xs text-muted-foreground">
              +{count - 8}
            </span>
          )}
        </div>
      )}

      {expanded && !isEvent && <BinPhotoPicker group={group} busy={busy} onRestore={onRestore} onPurge={onPurge} />}
    </GlassCard>
  );
}

/**
 * Every photo in one bin entry, to pick from.
 *
 * This is the case the bin exists for: a batch deleted as a duplicate turns out
 * to hold a few photographs that were not in the other one. Tapping a photo
 * selects it; the selection can go back to the event or be deleted for good.
 */
function BinPhotoPicker({
  group,
  busy,
  onRestore,
  onPurge,
}: {
  group: BinEntry;
  busy: boolean;
  onRestore: (photos?: string[]) => void;
  onPurge: (photos?: string[]) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const detail = useQuery({
    queryKey: ["bin", group.id],
    queryFn: () => api.binEntry(group.id),
    retry: false,
  });

  const photos = detail.data?.photos ?? [];
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const everySelected = photos.length > 0 && photos.every((p) => selected.has(p.id));
  const chosen = [...selected];

  return (
    <div className="mt-4 border-t border-hairline pt-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {selected.size > 0
            ? `${formatCount(selected.size, "photo")} selected`
            : "Tap the photos you want back."}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <GlassButton
            variant="ghost"
            size="sm"
            onClick={() => setSelected(everySelected ? new Set() : new Set(photos.map((p) => p.id)))}
          >
            {everySelected ? "Clear" : "Select all"}
          </GlassButton>
          <GlassButton
            variant="quiet"
            size="sm"
            icon={<RotateCcw className="size-4" />}
            disabled={selected.size === 0 || busy}
            onClick={() => {
              onRestore(chosen);
              setSelected(new Set());
            }}
          >
            Restore selected
          </GlassButton>
          <GlassButton
            variant="danger"
            size="sm"
            icon={<Trash2 className="size-4" />}
            disabled={selected.size === 0 || busy}
            onClick={() => {
              onPurge(chosen);
              setSelected(new Set());
            }}
          >
            Delete selected forever
          </GlassButton>
        </div>
      </div>

      {detail.isLoading ? (
        <Shimmer className="h-40" />
      ) : (
        <PhotoGrid
          photos={photos}
          onOpen={(index) => {
            const photo = photos[index];
            if (photo) toggle(photo.id);
          }}
          selected={selected}
          onToggleSelect={toggle}
        />
      )}
    </div>
  );
}
