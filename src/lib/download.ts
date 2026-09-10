/**
 * Saving a photo to the member's machine.
 *
 * The image is fetched rather than linked to directly, because a plain
 * `<a download>` pointing at another path opens the photo instead of saving it
 * in several browsers. Fetching it into a blob first makes the save reliable,
 * and it costs nothing extra: the Worker serves these with a long immutable
 * cache header, so the bytes are usually already in the browser.
 */

export async function downloadPhoto(url: string, fileName?: string): Promise<void> {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error("That photo could not be downloaded");

  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = fileName?.trim() || suggestName(url, blob.type);
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoked on the next tick so the click has taken the URL first.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
}

/** A sensible filename when the record did not carry one. */
function suggestName(url: string, mimeType: string): string {
  const id = url.split("/").pop() ?? "photo";
  const ext =
    mimeType === "image/avif" ? "avif" : mimeType === "image/webp" ? "webp" : "jpg";
  return `${id.slice(0, 8)}.${ext}`;
}
