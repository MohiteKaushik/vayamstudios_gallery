export type PhotoPage<T> = { key: number; photos: T[]; offset: number };

// R2 cursors are ordered by object key, not upload time. Never re-sort earlier
// pages when a later page arrives, even when its timestamps are newer.
export function stablePhotoPages<T extends { id: string }>(
  pages: readonly { photos: readonly T[] }[] | undefined,
): PhotoPage<T>[] {
  const seen = new Set<string>();
  const result: PhotoPage<T>[] = [];
  let offset = 0;
  pages?.forEach((page, key) => {
    const photos = page.photos.filter((photo) => {
      if (seen.has(photo.id)) return false;
      seen.add(photo.id);
      return true;
    });
    if (photos.length) result.push({ key, photos, offset });
    offset += photos.length;
  });
  return result;
}
