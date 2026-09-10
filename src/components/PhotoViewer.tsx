import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Download, Heart, Info, X } from "lucide-react";
import { GlassButton } from "./ui-kit";
import { downloadPhoto } from "@/lib/download";
import { cn } from "@/lib/utils";

export type ViewerPhoto = {
  id: string;
  /** Full-size image, served by the Worker behind the session cookie. */
  fullUrl: string;
  fileName?: string | null;
  /** 0 to 1, when this photo came from a scan. */
  confidence?: number | undefined;
  facesCount?: number | null;
  /** 0 when matched directly, higher when reached through the face graph. */
  hops?: number | undefined;
};

export function PhotoViewer({
  photos,
  index,
  onIndexChange,
  onClose,
  isFavorite,
  onToggleFavorite,
}: {
  photos: ViewerPhoto[];
  index: number;
  onIndexChange: (i: number) => void;
  onClose: () => void;
  isFavorite?: (id: string) => boolean;
  onToggleFavorite?: (id: string) => void;
}) {
  const photo = photos[index];
  const [details, setDetails] = useState(false);
  const url = photo?.fullUrl ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight" && index < photos.length - 1) onIndexChange(index + 1);
      if (e.key === "ArrowLeft" && index > 0) onIndexChange(index - 1);
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [index, photos.length, onClose, onIndexChange]);

  if (!photo) return null;
  const fav = isFavorite?.(photo.id) ?? false;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Photo viewer"
      className="fade-in fixed inset-0 z-50 flex flex-col bg-background/70 backdrop-blur-2xl"
    >
      <div className="glass-chrome flex items-center justify-between px-4 py-3">
        <GlassButton variant="ghost" size="sm" onClick={onClose} icon={<X className="size-4" />}>
          Close
        </GlassButton>
        <span className="text-[0.8rem] text-muted-foreground">
          {index + 1} of {photos.length}
        </span>
        <div className="flex items-center gap-1">
          {onToggleFavorite && (
            <GlassButton
              variant="ghost"
              size="sm"
              aria-label="Add to favorites"
              onClick={() => onToggleFavorite(photo.id)}
              icon={<Heart className={cn("size-4", fav && "fill-current text-accent")} />}
            />
          )}
          <GlassButton
            variant="ghost"
            size="sm"
            aria-label="Match details"
            onClick={() => setDetails((d) => !d)}
            icon={<Info className="size-4" />}
          />
          <GlassButton
            variant="ghost"
            size="sm"
            aria-label="Download photo"
            onClick={() => downloadPhoto(photo.fullUrl, photo.fileName ?? undefined)}
            icon={<Download className="size-4" />}
          />
        </div>
      </div>

      <div className="relative flex flex-1 items-center justify-center overflow-hidden p-3 sm:p-8">
        {url ? (
          <img
            key={photo.id}
            src={url}
            alt={photo.fileName ?? "Photo"}
            className="fade-in max-h-full max-w-full rounded-2xl object-contain shadow-[var(--shadow-lifted)]"
          />
        ) : (
          <div className="shimmer size-40 rounded-3xl bg-secondary" />
        )}

        {index > 0 && (
          <button
            aria-label="Previous photo"
            onClick={() => onIndexChange(index - 1)}
            className="press glass-chrome absolute left-3 flex size-11 items-center justify-center rounded-full border"
          >
            <ChevronLeft className="size-5" />
          </button>
        )}
        {index < photos.length - 1 && (
          <button
            aria-label="Next photo"
            onClick={() => onIndexChange(index + 1)}
            className="press glass-chrome absolute right-3 flex size-11 items-center justify-center rounded-full border"
          >
            <ChevronRight className="size-5" />
          </button>
        )}
      </div>

      {details && (
        <div className="glass-chrome rise-in safe-bottom border-t px-5 py-4 text-[0.82rem]">
          <p className="mb-2 font-medium">Match details</p>
          <dl className="grid grid-cols-2 gap-y-1 text-muted-foreground sm:grid-cols-4">
            <dt>File</dt>
            <dd className="truncate text-foreground">{photo.fileName ?? "—"}</dd>
            <dt>Faces detected</dt>
            <dd className="text-foreground">{photo.facesCount ?? 0}</dd>
            <dt>Match confidence</dt>
            <dd className="text-foreground">
              {photo.confidence != null ? `${Math.round(photo.confidence * 100)}%` : "—"}
            </dd>
            <dt>How it was found</dt>
            <dd className="text-foreground">
              {photo.hops == null ? "—" : photo.hops === 0 ? "Matched your reference photo" : "Reached through a turned-away view"}
            </dd>
          </dl>
        </div>
      )}
    </div>
  );
}
