import { useCallback, useEffect, useMemo, useState } from "react";
import type { GridPhoto } from "@/components/PhotoGrid";

export function usePhotoSelection(photos: GridPhoto[]) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const available = new Set(photos.map((photo) => photo.id));
    setSelected((current) => {
      const next = new Set([...current].filter((id) => available.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [photos]);

  const start = useCallback((id: string) => {
    setSelected((current) => {
      if (current.has(id)) return current;
      const next = new Set(current);
      next.add(id);
      return next;
    });
  }, []);

  const toggle = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clear = useCallback(() => setSelected(new Set()), []);
  const selectAll = useCallback(() => setSelected(new Set(photos.map((photo) => photo.id))), [photos]);
  const selectedPhotos = useMemo(() => photos.filter((photo) => selected.has(photo.id)), [photos, selected]);

  return {
    selected,
    selectedPhotos,
    active: selected.size > 0,
    start,
    toggle,
    clear,
    selectAll,
  };
}
