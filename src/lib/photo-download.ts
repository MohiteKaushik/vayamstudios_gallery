export type DownloadPhoto = { photoId: string; fileName: string; fullUrl: string };
export type Directory = {
  getDirectoryHandle(name: string, options: { create: boolean }): Promise<Directory>;
  getFileHandle(name: string, options: { create: boolean }): Promise<{
    createWritable(): Promise<WritableStream<Uint8Array>>;
  }>;
  removeEntry(name: string): Promise<void>;
};
export type DownloadResult = { saved: number; failed: string[]; blob?: Blob; folder: string };

export function safeFileName(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/^\.+|[. ]+$/g, "").slice(0, 100) || "photos";
}

// Call directly from the click handler, before fetching matches.
export async function choosePhotoDirectory(): Promise<Directory | null> {
  const picker = (window as Window & {
    showDirectoryPicker?: (options: { mode: string }) => Promise<Directory>;
  }).showDirectoryPicker;
  return picker ? picker.call(window, { mode: "readwrite" }) : null;
}

export async function downloadPhotos(
  photos: DownloadPhoto[],
  directory: Directory | null,
  label: string,
  signal: AbortSignal,
  progress: (saved: number, total: number) => void,
  fetcher: typeof fetch = fetch,
): Promise<DownloadResult> {
  const unique = [...new Map(photos.map((photo) => [photo.photoId, photo])).values()];
  const folder = `Vayam-${safeFileName(label)}-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
  const result: DownloadResult = { saved: 0, failed: [], folder };
  if (!unique.length) return result;
  signal.throwIfAborted();
  const target = directory ? await directory.getDirectoryHandle(folder, { create: true }) : null;
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  const ZIP_LIMIT = 200 * 1024 * 1024;
  const library = target ? null : await import("fflate");
  const zip = library ? new library.Zip((error, chunk) => {
    if (error) throw error;
    bytes += chunk.byteLength;
    if (bytes > ZIP_LIMIT) throw new Error("ZIP exceeds 200 MB. Use Chrome or Edge and choose a folder instead.");
    chunks.push(new Uint8Array(chunk));
  }) : null;
  try {
    for (const [index, photo] of unique.entries()) {
      signal.throwIfAborted();
      const name = `${String(index + 1).padStart(4, "0")}-${safeFileName(photo.fileName)}`;
      let created = false;
      try {
        // Only the app's authenticated image endpoint is an export source.
        if (!/^\/media\/p\/[a-f0-9-]+\/[a-f0-9-]+$/i.test(photo.fullUrl)) {
          throw new Error("Invalid photo URL");
        }
        const response = await fetcher(photo.fullUrl, { credentials: "same-origin", signal });
        if (!response.ok || !response.body || !response.headers.get("content-type")?.startsWith("image/")) {
          throw new Error(`Photo unavailable (${response.status})`);
        }
        if (target) {
          const handle = await target.getFileHandle(name, { create: true });
          created = true;
          await response.body.pipeTo(await handle.createWritable(), { signal });
        } else if (zip && library) {
          const entry = new library.ZipPassThrough(`${folder}/${name}`);
          zip.add(entry);
          const reader = response.body.getReader();
          try {
            while (true) {
              signal.throwIfAborted();
              const { done, value } = await reader.read();
              if (done) break;
              entry.push(value);
            }
            entry.push(new Uint8Array(), true);
          } finally {
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
          }
        }
        result.saved++;
      } catch (error) {
        if (created && target) await target.removeEntry(name).catch(() => undefined);
        signal.throwIfAborted();
        // Never hand out a ZIP containing an incomplete or corrupt file.
        if (!target) throw error;
        result.failed.push(photo.fileName);
      }
      progress(result.saved, unique.length);
    }
    signal.throwIfAborted();
    zip?.end();
    if (zip) result.blob = new Blob(chunks, { type: "application/zip" });
    return result;
  } finally {
    zip?.terminate();
  }
}
