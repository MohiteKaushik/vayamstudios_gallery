import { PhotoGrid, type GridPhoto } from "./PhotoGrid";
import type { PhotoPage } from "@/lib/photo-pages";
import { useEffect, useRef, useState } from "react";
import { layoutPhotos } from "@/lib/photo-layout";

export function PagedPhotoGrid({
  pages,
  onOpen,
}: {
  pages: PhotoPage<GridPhoto>[];
  onOpen: (index: number) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const photos = pages.flatMap((page) => page.photos);
  const columns = width >= 1100 ? 4 : width >= 720 ? 3 : 2;
  const layout = layoutPhotos(photos, width, columns);
  return (
    <div ref={container} data-photo-layout className="relative" style={{ height: width ? layout.height : undefined }}>
      {width > 0 && photos.map((photo, index) => (
        <div key={photo.id} data-photo-id={photo.id} className="absolute" style={layout.items[index]}>
          <PhotoGrid singleColumn photos={[photo]} onOpen={() => onOpen(index)} />
        </div>
      ))}
    </div>
  );
}
