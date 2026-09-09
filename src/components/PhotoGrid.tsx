import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { signedUrls } from "@/lib/photo-urls";
import { Shimmer } from "./ui-kit";

export type GridPhoto = {
  id: string;
  storage_path: string;
  width: number | null;
  height: number | null;
  file_name?: string | null;
};

export function usePhotoUrls(photos: { storage_path: string }[]) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const key = photos.map((p) => p.storage_path).join("|");

  useEffect(() => {
    let active = true;
    if (!photos.length) return;
    signedUrls(photos.map((p) => p.storage_path)).then((u) => active && setUrls(u));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return urls;
}

export function PhotoGrid({
  photos,
  onOpen,
  selected,
  onToggleSelect,
}: {
  photos: GridPhoto[];
  onOpen: (index: number) => void;
  selected?: Set<string>;
  onToggleSelect?: (id: string) => void;
}) {
  const urls = usePhotoUrls(photos);

  return (
    <div className="[column-fill:_balance] columns-2 gap-3 md:columns-3 xl:columns-4">
      {photos.map((photo, index) => {
        const url = urls[photo.storage_path];
        const ratio =
          photo.width && photo.height ? photo.width / photo.height : 3 / 4;
        const isSelected = selected?.has(photo.id);

        return (
          <div key={photo.id} className="mb-3 break-inside-avoid">
            <div
              role="button"
              tabIndex={0}
              onClick={() => onOpen(index)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpen(index);
                }
              }}
              className={cn(
                "group press relative w-full overflow-hidden rounded-2xl bg-secondary",
                isSelected && "ring-2 ring-accent ring-offset-2 ring-offset-background",
              )}
              style={{ aspectRatio: `${ratio}` }}
            >
              {url ? (
                <img
                  src={url}
                  alt={photo.file_name ?? "Matched photo"}
                  loading="lazy"
                  decoding="async"
                  className="fade-in size-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.04]"
                />
              ) : (
                <Shimmer className="size-full rounded-2xl" />
              )}

              {onToggleSelect && (
                <button
                  aria-label={isSelected ? "Deselect photo" : "Select photo"}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleSelect(photo.id);
                  }}
                  className={cn(
                    "press absolute right-2 top-2 flex size-7 items-center justify-center rounded-full border border-hairline opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100",
                    isSelected
                      ? "bg-accent text-accent-foreground opacity-100"
                      : "glass-chrome text-foreground",
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
          <Shimmer
            className="w-full rounded-2xl"
            // varied heights read as a real masonry layout while loading
          />
          <div style={{ height: 0 }} />
        </div>
      ))}
    </div>
  );
}
