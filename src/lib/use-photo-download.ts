import { useEffect, useRef, useState } from "react";
import type { GridPhoto } from "@/components/PhotoGrid";
import { choosePhotoDirectory, downloadPhotos } from "@/lib/photo-download";

export function usePhotoDownload(photos: GridPhoto[], label: string) {
  const controller = useRef<AbortController | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => () => controller.current?.abort(), []);

  async function start() {
    if (controller.current || photos.length === 0) return;
    const abort = new AbortController();
    controller.current = abort;
    setDownloading(true);
    setMessage("Choose a folder for your photos…");
    try {
      const directory = await choosePhotoDirectory();
      abort.signal.throwIfAborted();
      setMessage(`Downloading 0 of ${photos.length} photos…`);
      const result = await downloadPhotos(
        photos.map((photo) => ({
          photoId: photo.id,
          fileName: photo.fileName ?? "photo.jpg",
          fullUrl: photo.fullUrl,
        })),
        directory,
        label,
        abort.signal,
        (saved, total) => setMessage(`Downloading ${saved} of ${total} photos…`),
      );
      if (result.blob) {
        const url = URL.createObjectURL(result.blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${result.folder}.zip`;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
      const savedAt = result.blob ? "Your ZIP download has started." : `Saved in the ${result.folder} folder.`;
      setMessage(result.failed.length
        ? `${result.saved} photos downloaded. ${result.failed.length} could not be saved; please try again. ${savedAt}`
        : `All ${result.saved} photos downloaded. ${savedAt}`);
    } catch (error) {
      const cancelled = abort.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
      setMessage(cancelled ? "Download cancelled." : error instanceof Error ? error.message : "The photos could not be downloaded.");
    } finally {
      controller.current = null;
      setDownloading(false);
    }
  }

  return { downloading, message, start };
}
