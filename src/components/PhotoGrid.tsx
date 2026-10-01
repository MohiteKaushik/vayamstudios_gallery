import { Check } from "lucide-react";
import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import { cn } from "@/lib/utils";
import { Shimmer } from "./ui-kit";
import { photoAspectRatio } from "@/lib/photo-layout";

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
  selectionMode = false,
  onLongPress,
  showConfidence,
  singleColumn = false,
  showFileNames = false,
}: {
  photos: GridPhoto[];
  onOpen: (index: number) => void;
  selected?: Set<string>;
  onToggleSelect?: (id: string) => void;
  selectionMode?: boolean;
  onLongPress?: (id: string) => void;
  showConfidence?: boolean;
  singleColumn?: boolean;
  showFileNames?: boolean;
}) {
  return (
    <div className={singleColumn ? "" : "[column-fill:_balance] columns-2 gap-3 md:columns-3 xl:columns-4"}>
      {photos.map((photo, index) => {
        const ratio = photoAspectRatio(photo);
        const isSelected = selected?.has(photo.id);

        return (
          <div key={photo.id} className={singleColumn ? "" : "mb-3 break-inside-avoid"}>
            <PhotoTile
              photo={photo}
              ratio={ratio}
              index={index}
              isSelected={!!isSelected}
              selectionMode={selectionMode}
              onOpen={onOpen}
              {...(onToggleSelect ? { onToggleSelect } : {})}
              {...(onLongPress ? { onLongPress } : {})}
              {...(showConfidence !== undefined ? { showConfidence } : {})}
            />
            {showFileNames && <p className="mt-1 break-all px-1 text-xs text-muted-foreground">{photo.fileName ?? photo.id}</p>}
          </div>
        );
      })}
    </div>
  );
}

function PhotoTile({
  photo,
  ratio,
  index,
  isSelected,
  selectionMode,
  onOpen,
  onToggleSelect,
  onLongPress,
  showConfidence,
}: {
  photo: GridPhoto;
  ratio: number;
  index: number;
  isSelected: boolean;
  selectionMode: boolean;
  onOpen: (index: number) => void;
  onToggleSelect?: (id: string) => void;
  onLongPress?: (id: string) => void;
  showConfidence?: boolean;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  const held = useRef(false);

  const cancelHold = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const beginHold = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!onLongPress || (event.pointerType === "mouse" && event.button !== 0)) return;
    cancelHold();
    held.current = false;
    origin.current = { x: event.clientX, y: event.clientY };
    timer.current = setTimeout(() => {
      held.current = true;
      onLongPress(photo.id);
      navigator.vibrate?.(12);
    }, 500);
  };
  const moveHold = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (Math.hypot(event.clientX - origin.current.x, event.clientY - origin.current.y) > 10) cancelHold();
  };
  const activate = () => {
    if (held.current) {
      held.current = false;
      return;
    }
    if (selectionMode && onToggleSelect) onToggleSelect(photo.id);
    else onOpen(index);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={selectionMode
        ? `${isSelected ? "Deselect" : "Select"} ${photo.fileName ?? "photo"}`
        : `Open ${photo.fileName ?? "photo"}`}
      aria-pressed={selectionMode ? isSelected : undefined}
      onClick={activate}
      onPointerDown={beginHold}
      onPointerMove={moveHold}
      onPointerUp={cancelHold}
      onPointerCancel={cancelHold}
      onPointerLeave={cancelHold}
      onContextMenu={(event) => {
        if (onLongPress) event.preventDefault();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate();
        }
      }}
      className={cn(
        "group press relative w-full touch-pan-y select-none overflow-hidden rounded-2xl bg-secondary",
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
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleSelect(photo.id);
                  }}
                  className={cn(
                    "press absolute right-2 top-2 flex size-7 items-center justify-center rounded-full border border-hairline transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    isSelected
                      ? "bg-accent text-accent-foreground opacity-100"
                      : selectionMode
                        ? "bg-background/20 text-foreground/70 opacity-100 backdrop-blur-[1px]"
                        : "glass-chrome text-foreground opacity-0 group-hover:opacity-100",
                  )}
                >
                  {isSelected ? <Check className="size-4" strokeWidth={2.4} /> : null}
                </button>
              )}
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
