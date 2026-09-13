import { Check, Copy, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyState, GlassButton, GlassCard, useConfirm } from "@/components/ui-kit";
import { api, type Photo } from "@/lib/api";
import { LEVELS, findDuplicateGroups, type DuplicateGroup } from "@/lib/duplicates";
import { fingerprintMany } from "@/lib/fingerprint-browser";
import { formatCount } from "@/lib/images";
import { dayLabel, timeLabel } from "@/lib/time";
import { cn } from "@/lib/utils";

const GROUPS_PER_PAGE = 30;

/**
 * Duplicate photos in one event, for the admin to review and clear.
 *
 * Every photo gets a fingerprint the first time this opens, read from its
 * thumbnail in this browser and saved to the photo, so the next time is
 * instant and only new uploads are read. Exact copies arrive pre-selected with
 * the best copy of each kept; similar shots are shown but left for the admin
 * to choose. Anything removed goes to the recycle bin, so a wrong call can be
 * undone for thirty days.
 */
export function DuplicatesPanel({
  collectionId,
  photos,
  onClose,
  onDelete,
  deleting,
}: {
  collectionId: string;
  photos: Photo[];
  onClose: () => void;
  onDelete: (ids: string[]) => Promise<unknown>;
  deleting: boolean;
}) {
  const { ask, dialog } = useConfirm();
  const [known, setKnown] = useState<Map<string, string>>(() => {
    const m = new Map<string, string>();
    for (const p of photos) if (p.fingerprint) m.set(p.id, p.fingerprint);
    return m;
  });
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [level, setLevel] = useState<"exact" | "similar">("exact");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState(GROUPS_PER_PAGE);
  const cancelled = useRef(false);

  // Read whatever has no fingerprint yet, then remember the results on the server.
  useEffect(() => {
    cancelled.current = false;
    const missing = photos.filter((p) => !known.has(p.id));
    if (missing.length === 0) return;
    setProgress({ done: 0, total: missing.length });
    void (async () => {
      const found = await fingerprintMany(missing, (done, total) => setProgress({ done, total }), () => cancelled.current);
      if (cancelled.current) return;
      setKnown((prev) => new Map([...prev, ...found]));
      setProgress(null);
      const items = [...found].map(([photoId, fingerprint]) => ({ photoId, fingerprint }));
      for (let i = 0; i < items.length; i += 200) {
        // Saving is a shortcut for next time, never a reason to fail now.
        await api.saveFingerprints(collectionId, items.slice(i, i + 200)).catch(() => undefined);
      }
    })();
    return () => {
      cancelled.current = true;
    };
    // Photos that arrive later are read the next time the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionId]);

  const byId = useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos]);

  const groups = useMemo<DuplicateGroup[]>(() => {
    if (progress) return [];
    const candidates = photos
      .filter((p) => known.has(p.id))
      .map((p) => ({ id: p.id, width: p.width, height: p.height, createdAt: p.createdAt, fingerprint: known.get(p.id)! }));
    return findDuplicateGroups(candidates, LEVELS[level]);
  }, [photos, known, level, progress]);

  // Exact copies start selected; similar shots are the admin's call.
  useEffect(() => {
    setSelected(new Set(groups.flatMap((g) => g.copies.filter((c) => c.exact).map((c) => c.id))));
    setShown(GROUPS_PER_PAGE);
  }, [groups]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const extraCopies = groups.reduce((n, g) => n + g.copies.length, 0);

  async function removeSelected() {
    const ids = [...selected].filter((id) => byId.has(id));
    if (!ids.length) return;
    const ok = await ask({
      title: `Move ${formatCount(ids.length, "photo")} to the recycle bin?`,
      body: "You can restore them from the recycle bin in the admin console for 30 days.",
      confirmLabel: "Move to bin",
    });
    if (!ok) return;
    await onDelete(ids);
    setSelected(new Set());
  }

  return (
    <GlassCard className="mb-8 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-[-0.02em]">
            <Copy className="size-5" strokeWidth={1.6} /> Duplicate photos
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {progress
              ? `Reading photos, ${progress.done} of ${progress.total}. This is saved, so next time is instant.`
              : groups.length === 0
                ? "No duplicates found."
                : `${formatCount(groups.length, "group")}, ${formatCount(extraCopies, "extra copy", "extra copies")}. The best copy of each is kept.`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-full bg-secondary p-1 text-[0.82rem]">
            {(["exact", "similar"] as const).map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLevel(l)}
                className={cn(
                  "press rounded-full px-3 py-1.5",
                  level === l ? "bg-background shadow-[var(--shadow-soft)]" : "text-muted-foreground",
                )}
              >
                {l === "exact" ? "Exact copies" : "Also similar shots"}
              </button>
            ))}
          </div>
          <GlassButton variant="ghost" size="sm" icon={<X className="size-4" />} onClick={onClose}>
            Close
          </GlassButton>
        </div>
      </div>

      {progress && (
        <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-secondary">
          <div
            className="h-full bg-foreground/70 transition-[width]"
            style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }}
          />
        </div>
      )}

      {!progress && groups.length === 0 && (
        <div className="mt-4">
          <EmptyState
            icon={<Check className="size-7" strokeWidth={1.5} />}
            title="No duplicates"
            description={
              level === "exact"
                ? "No photo in this event was uploaded more than once. Try \"Also similar shots\" to look for near-identical frames."
                : "No near-identical frames either."
            }
          />
        </div>
      )}

      {!progress && groups.length > 0 && (
        <>
          <div className="glass-chrome sticky top-20 z-10 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border px-4 py-3">
            <span className="text-sm font-medium">{formatCount(selected.size, "photo")} selected</span>
            <div className="flex items-center gap-2">
              <GlassButton variant="ghost" size="sm" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
                Clear
              </GlassButton>
              <GlassButton
                variant="danger"
                size="sm"
                icon={<Trash2 className="size-4" />}
                loading={deleting}
                disabled={selected.size === 0}
                onClick={() => void removeSelected()}
              >
                Move to recycle bin
              </GlassButton>
            </div>
          </div>

          <ul className="mt-4 space-y-4">
            {groups.slice(0, shown).map((group) => {
              const members = [
                { id: group.keep, note: "Best copy", exact: true, keep: true },
                ...group.copies.map((c) => ({ id: c.id, note: c.exact ? "Exact copy" : "Similar", exact: c.exact, keep: false })),
              ];
              return (
                <li key={group.keep} className="rounded-2xl border border-hairline p-3">
                  <div className="flex gap-3 overflow-x-auto pb-1">
                    {members.map((m) => {
                      const photo = byId.get(m.id);
                      if (!photo) return null;
                      const isSelected = selected.has(m.id);
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => toggle(m.id)}
                          aria-pressed={isSelected}
                          aria-label={`${isSelected ? "Unselect" : "Select"} ${photo.fileName}`}
                          className={cn(
                            "press relative w-40 shrink-0 overflow-hidden rounded-xl bg-secondary text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            isSelected && "ring-2 ring-destructive ring-offset-2 ring-offset-background",
                          )}
                        >
                          <img src={photo.thumbUrl} alt={photo.fileName} loading="lazy" className="aspect-square w-full object-cover" />
                          <span
                            className={cn(
                              "absolute left-2 top-2 rounded-full px-2 py-0.5 text-[0.68rem] font-medium",
                              m.keep ? "bg-emerald-600 text-white" : m.exact ? "bg-destructive text-white" : "bg-amber-500 text-black",
                            )}
                          >
                            {m.note}
                          </span>
                          {isSelected && (
                            <span className="absolute right-2 top-2 flex size-6 items-center justify-center rounded-full bg-destructive text-white">
                              <Trash2 className="size-3.5" />
                            </span>
                          )}
                          <span className="block px-2 py-1.5 text-[0.7rem] leading-tight text-muted-foreground">
                            {dayLabel(photo.createdAt)} · {timeLabel(photo.createdAt)}
                            <br />
                            {photo.width} x {photo.height}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </li>
              );
            })}
          </ul>

          {groups.length > shown && (
            <div className="mt-4 flex justify-center">
              <GlassButton variant="quiet" size="sm" onClick={() => setShown((n) => n + GROUPS_PER_PAGE)}>
                Show {Math.min(GROUPS_PER_PAGE, groups.length - shown)} more groups
              </GlassButton>
            </div>
          )}
        </>
      )}
      {dialog}
    </GlassCard>
  );
}
