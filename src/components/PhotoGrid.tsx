import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Shimmer } from "./ui-kit";

/**
 * A photo, carrying the URLs to fetch it.
 *
 * Photos used to arrive as a storage path that every screen then exchanged for
 * a signed URL, which meant a round trip per batch before anything could
 * render. The Worker now serves them behind the session cookie, so the URL is
 * just a path and the grid can paint immediately.
 */
export type GridPhoto = {
  id: string;
  /** Grid-sized copy. A few kilobytes rather than a few megabytes. */
  thumbUrl: string;
  fullUrl: string;
  width: number | null;
  height: number | null;
  fileName?: string | null;
  /** 0 to 1, when this photo came from a scan. */
  confidence?: number;
};

export function PhotoGrid({
  photos,
  onOpen,
  selected,
  onToggleSelect,
  showConfidence,
}: {
  photos: GridPhoto[];
  onOpen: (index: number) => void;
  selected?: Set<string>;
  onToggleSelect?: (id: string) => void;
  showConfidence?: boolean;
}) {
  return (
    <div className="[column-fill:_balance] columns-2 gap-3 md:columns-3 xl:columns-4">
      {photos.map((photo, index) => {
        const ratio = photo.width && photo.height ? photo.width / photo.height : 3 / 4;
        const isSelected = selected?.has(photo.id);

        return (
          <div key={photo.id} className="mb-3 break-inside-avoid">
            <div
              role="button"
              tabIndex={0}
              aria-label={`Open ${photo.fileName ?? "photo"}`}
              onClick={() => onOpen(index)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpen(index);
                }
              }}
              className={cn(
                "group press relative w-full overflow-hidden rounded-2xl bg-secondary",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isSelected && "ring-2 ring-accent ring-offset-2 ring-offset-background",
              )}
              style={{ aspectRatio: `${ratio}` }}
            >
              <img
                src={photo.thumbUrl}
                alt={photo.fileName ?? "Photo"}
                loading="lazy"
                decoding="async"
                className="fade-in size-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.04]"
                onError={(e) => {
                  // A thumbnail can be missing when its upload failed after the
                  // full image succeeded. Fall back rather than show a gap.
                  const img = e.currentTarget;
                  if (img.src !== photo.fullUrl) img.src = photo.fullUrl;
                }}
              />

              {showConfidence && photo.confidence !== undefined && (
                <span className="glass-chrome absolute bottom-2 left-2 rounded-full px-2 py-0.5 text-[0.7rem] font-medium tabular-nums">
                  {Math.round(photo.confidence * 100)}%
                </span>
              )}

              {onToggleSelect && (
                <button
                  aria-label={isSelected ? `Deselect ${photo.fileName ?? "photo"}` : `Select ${photo.fileName ?? "photo"}`}
                  aria-pressed={!!isSelected}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleSelect(photo.id);
                  }}
                  className={cn(
                    "press absolute right-2 top-2 flex size-7 items-center justify-center rounded-full border border-hairline transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    isSelected
                      ? "bg-accent text-accent-foreground opacity-100"
                      : "glass-chrome text-foreground opacity-0 group-hover:opacity-100",
                  )}
                >
                  <Check className="size-4" strokeWidth={2.4} />
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function PhotoGridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="columns-2 gap-3 md:columns-3 xl:columns-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="mb-3 break-inside-avoid">
          {/* Varied heights so the placeholder reads as the masonry it becomes. */}
          <Shimmer className={cn("w-full rounded-2xl", i % 3 === 0 ? "aspect-[3/4]" : "aspect-[4/3]")} />
        </div>
      ))}
    </div>
  );
}
