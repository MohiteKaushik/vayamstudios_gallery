type Dimensions = { width: number | null; height: number | null };

export function photoAspectRatio(photo: Dimensions): number {
  return photo.width && photo.height && Number.isFinite(photo.width) && Number.isFinite(photo.height)
    && photo.width > 0 && photo.height > 0 ? photo.width / photo.height : 3 / 4;
}

// Prefix-stable placement: appending photos never changes earlier coordinates.
export function layoutPhotos(photos: readonly Dimensions[], width: number, columns: number, gap = 12) {
  const columnWidth = Math.max(0, (width - gap * (columns - 1)) / columns);
  const bottoms = Array<number>(columns).fill(0);
  const items = photos.map((photo) => {
    let column = 0;
    for (let i = 1; i < columns; i++) if (bottoms[i]! < bottoms[column]!) column = i;
    const top = bottoms[column]!;
    const height = columnWidth / photoAspectRatio(photo);
    bottoms[column] = top + height + gap;
    return { left: column * (columnWidth + gap), top, width: columnWidth, height };
  });
  return { items, height: photos.length ? Math.max(...bottoms) - gap : 0 };
}
