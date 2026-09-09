/**
 * Image encoding for stored photos.
 *
 * The brief was to compress as hard as possible without giving up quality.
 * Those pull against each other only if the codec is fixed. They stop pulling
 * against each other when the codec changes: WebP reaches the same perceived
 * quality as JPEG at roughly 25 to 35 percent fewer bytes, and AVIF does better
 * again. So the win here is not a lower quality setting, it is a better format
 * at the same visual quality.
 *
 * This matters most for what people actually upload. A PNG straight out of a
 * design tool or a screenshot can be ten times the size of the same picture as
 * WebP with no visible difference, because PNG is lossless and photographs do
 * not benefit from that.
 *
 * THE TRAP THIS AVOIDS
 *
 * `canvas.toBlob(cb, "image/webp")` does not fail on a browser that cannot
 * encode WebP. It quietly hands back a PNG instead, and a caller that trusts
 * the format it asked for ends up storing images several times larger than
 * intended while believing compression is working. Every format here is proven
 * by encoding a real pixel and reading the type off the result.
 */

export type EncodedImage = {
  blob: Blob;
  /** The format actually produced, which is not always the one requested. */
  format: "image/avif" | "image/webp" | "image/jpeg";
  quality: number;
};

/**
 * Quality settings chosen to sit at or above visually lossless for photographs.
 *
 * WebP and AVIF are perceptually ahead of JPEG at the same number, so they run
 * lower and still look better. Going under these starts showing on skin tones
 * and flat gradients, which is exactly the material in event photography.
 */
const QUALITY: Record<EncodedImage["format"], number> = {
  "image/avif": 0.62,
  "image/webp": 0.86,
  "image/jpeg": 0.9,
};

/** Best first. */
const PREFERRED: EncodedImage["format"][] = ["image/avif", "image/webp", "image/jpeg"];

let supportedPromise: Promise<EncodedImage["format"]> | null = null;

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Finds the best format this browser can genuinely encode.
 *
 * Asking is not enough, because an unsupported type silently produces PNG. The
 * only reliable check is to encode something and look at what came back.
 */
export async function bestSupportedFormat(): Promise<EncodedImage["format"]> {
  if (!supportedPromise) {
    supportedPromise = (async () => {
      const probe = document.createElement("canvas");
      probe.width = 8;
      probe.height = 8;
      const ctx = probe.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "#8a7f6d";
        ctx.fillRect(0, 0, 8, 8);
      }
      for (const format of PREFERRED) {
        try {
          const blob = await toBlob(probe, format, QUALITY[format]);
          if (blob && blob.type === format) return format;
        } catch {
          // Try the next one.
        }
      }
      return "image/jpeg";
    })();
  }
  return supportedPromise;
}

/** File extension for a stored object of this type. */
export function extensionFor(format: EncodedImage["format"]): string {
  return format === "image/avif" ? "avif" : format === "image/webp" ? "webp" : "jpg";
}

/**
 * Encodes a canvas as small as it will go without visible loss.
 *
 * AVIF encoding is slow enough to stall a bulk upload, so it is only used when
 * it actually pays: if it does not beat WebP on size for this picture, the WebP
 * result is kept. Falls back to JPEG wherever nothing better exists.
 */
export async function encodeImage(
  canvas: HTMLCanvasElement,
  options: { format?: EncodedImage["format"]; quality?: number } = {},
): Promise<EncodedImage> {
  const format = options.format ?? (await bestSupportedFormat());
  const quality = options.quality ?? QUALITY[format];

  const blob = await toBlob(canvas, format, quality);
  if (blob && blob.type === format) return { blob, format, quality };

  // The browser changed its mind between the probe and now, or the picture hit
  // a codec edge case. JPEG is universal.
  const fallback = await toBlob(canvas, "image/jpeg", QUALITY["image/jpeg"]);
  if (!fallback) throw new Error("Image could not be encoded");
  return { blob: fallback, format: "image/jpeg", quality: QUALITY["image/jpeg"] };
}

/**
 * How much smaller the stored copy is than what was handed in.
 * Negative would mean the encode made things worse, which is worth knowing.
 */
export function savingsPercent(originalBytes: number, storedBytes: number): number {
  if (originalBytes <= 0) return 0;
  return Math.round(((originalBytes - storedBytes) / originalBytes) * 100);
}

/** Human-readable byte size for progress and logs. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
