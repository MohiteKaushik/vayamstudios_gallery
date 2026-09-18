import { PhotoGrid, type GridPhoto } from "./PhotoGrid";
import type { PhotoPage } from "@/lib/photo-pages";

export function PagedPhotoGrid({
  pages,
  onOpen,
}: {
  pages: PhotoPage<GridPhoto>[];
  onOpen: (index: number) => void;
}) {
  // Separate column containers prevent CSS masonry from rebalancing old tiles.
  return (
    <div>
      {pages.map((page) => (
        <div key={page.key} data-photo-page={page.key} className="flow-root">
          <PhotoGrid photos={page.photos} onOpen={(index) => onOpen(page.offset + index)} />
        </div>
      ))}
    </div>
  );
}
