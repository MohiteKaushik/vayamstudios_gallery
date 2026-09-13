/**
 * Fingerprinting photos in the browser, for duplicate detection.
 *
 * The thumbnail is enough: a duplicate is the same picture, and 512 pixels
 * says that as clearly as the full frame while costing a fiftieth of the
 * download. Thumbnails are also cached forever by the browser, so looking at
 * an event again downloads nothing.
 */

import { SOURCE_SIZE, fingerprintPixels } from "./duplicates";

let canvas: HTMLCanvasElement | null = null;

/** Reads one photo and returns its fingerprint. */
export async function fingerprintFromUrl(url: string): Promise<string> {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`Could not read a photo (${res.status})`);
  const bitmap = await createImageBitmap(await res.blob());
  try {
    canvas ??= document.createElement("canvas");
    canvas.width = SOURCE_SIZE;
    canvas.height = SOURCE_SIZE;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("This browser would not give us a canvas to work on");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, SOURCE_SIZE, SOURCE_SIZE);
    return fingerprintPixels(ctx.getImageData(0, 0, SOURCE_SIZE, SOURCE_SIZE).data);
  } finally {
    bitmap.close();
  }
}

/**
 * Fingerprints many photos a few at a time, reporting as it goes.
 * A photo that cannot be read is skipped rather than stopping the rest.
 */
export async function fingerprintMany(
  photos: { id: string; thumbUrl: string; fullUrl: string }[],
  onProgress: (done: number, total: number) => void,
  isCancelled: () => boolean,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const queue = [...photos];
  let done = 0;
  const worker = async () => {
    while (queue.length && !isCancelled()) {
      const photo = queue.shift()!;
      try {
        out.set(photo.id, await fingerprintFromUrl(photo.thumbUrl));
      } catch {
        try {
          out.set(photo.id, await fingerprintFromUrl(photo.fullUrl));
        } catch {
          // Unreadable. Left out of the comparison rather than guessed at.
        }
      }
      onProgress(++done, photos.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return out;
}
