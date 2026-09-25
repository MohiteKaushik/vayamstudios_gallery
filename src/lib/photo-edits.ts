export type PhotoEdits = {
  rotation: number;
  tilt: number;
  flip: boolean;
  flipVertical: boolean;
  brightness: number;
  contrast: number;
  saturation: number;
  warmth: number;
  shadows: number;
};

export const ORIGINAL_EDITS: Readonly<PhotoEdits> = Object.freeze({
  rotation: 0, tilt: 0, flip: false, flipVertical: false,
  brightness: 100, contrast: 100, saturation: 100, warmth: 0, shadows: 0,
});

export function hasPhotoEdits(edits: Readonly<PhotoEdits>): boolean {
  return edits.rotation % 360 !== 0 || edits.tilt !== 0 || edits.flip || edits.flipVertical ||
    edits.brightness !== 100 || edits.contrast !== 100 || edits.saturation !== 100 ||
    edits.warmth !== 0 || edits.shadows !== 0;
}

const MAX_EDIT_PIXELS = 40_000_000;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

async function openPhoto(file: File) {
  if (!["image/jpeg", "image/png", "image/webp", "image/avif"].includes(file.type)) {
    throw new Error("Choose a JPEG, PNG, WebP or AVIF photo.");
  }
  if (file.size > MAX_UPLOAD_BYTES) throw new Error("This photo exceeds the 25 MB upload limit.");
  const url = URL.createObjectURL(file);
  const image = new Image();
  const release = () => { image.src = ""; URL.revokeObjectURL(url); };
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("This photo could not be opened. Choose another file."));
      image.src = url;
    });
    if (image.naturalWidth * image.naturalHeight > MAX_EDIT_PIXELS ||
        Math.max(image.naturalWidth, image.naturalHeight) > 16384) {
      throw new Error("This photo is too large for the editor. You can still upload its original with Add photos.");
    }
    return { image, release };
  } catch (error) {
    release();
    throw error;
  }
}

export async function createEditPreview(file: File): Promise<HTMLCanvasElement> {
  const { image, release } = await openPhoto(file);
  try {
    const scale = Math.min(1, 1280 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("The photo preview could not be created.");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    release();
  }
}

function drawPhoto(canvas: HTMLCanvasElement, source: CanvasImageSource, width: number, height: number, edits: Readonly<PhotoEdits>) {
  const turned = Math.abs(edits.rotation % 180) === 90;
  canvas.width = turned ? height : width;
  canvas.height = turned ? width : height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("The photo could not be edited in this browser.");
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  const tilt = edits.tilt * Math.PI / 180;
  // Zoom only enough to cover the inverse-rotated output rectangle. A tiny
  // overscan avoids transparent antialiasing at the four output corners.
  const zoom = edits.tilt === 0 ? 1 : Math.cos(tilt) + Math.abs(Math.sin(tilt)) *
    Math.max(width / height, height / width) + 2 / Math.min(width, height);
  ctx.rotate((edits.rotation + edits.tilt) * Math.PI / 180);
  ctx.scale(zoom * (edits.flip ? -1 : 1), zoom * (edits.flipVertical ? -1 : 1));
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, -width / 2, -height / 2, width, height);
  ctx.restore();
  return ctx;
}

async function adjustColour(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, edits: Readonly<PhotoEdits>, signal?: AbortSignal) {
  if (edits.brightness === 100 && edits.contrast === 100 && edits.saturation === 100 &&
      edits.warmth === 0 && edits.shadows === 0) return;
  const brightness = edits.brightness / 100;
  const contrast = edits.contrast / 100;
  const saturation = edits.saturation / 100;
  const warmth = edits.warmth * 0.4;
  const shadows = edits.shadows * 0.7;
  // Small strips bound temporary memory and give navigation and progress time to paint.
  for (let y = 0; y < canvas.height; y += 128) {
    signal?.throwIfAborted();
    const strip = ctx.getImageData(0, y, canvas.width, Math.min(128, canvas.height - y));
    const pixels = strip.data;
    for (let i = 0; i < pixels.length; i += 4) {
      const r = (pixels[i]! * brightness - 127.5) * contrast + 127.5;
      const g = (pixels[i + 1]! * brightness - 127.5) * contrast + 127.5;
      const b = (pixels[i + 2]! * brightness - 127.5) * contrast + 127.5;
      const grey = r * 0.2126 + g * 0.7152 + b * 0.0722;
      const lift = shadows * (1 - Math.min(1, Math.max(0, grey / 255))) ** 2;
      pixels[i] = grey + (r - grey) * saturation + warmth + lift;
      pixels[i + 1] = grey + (g - grey) * saturation + lift;
      pixels[i + 2] = grey + (b - grey) * saturation - warmth + lift;
    }
    ctx.putImageData(strip, 0, y);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

export async function renderEditPreview(canvas: HTMLCanvasElement, source: HTMLCanvasElement, edits: Readonly<PhotoEdits>, signal: AbortSignal) {
  signal.throwIfAborted();
  const ctx = drawPhoto(canvas, source, source.width, source.height, edits);
  await adjustColour(canvas, ctx, edits, signal);
}

export async function applyPhotoEdits(file: File, edits: Readonly<PhotoEdits>): Promise<File> {
  // This identity return is essential: untouched photos never pass through an encoder.
  if (!hasPhotoEdits(edits)) return file;
  const { image, release } = await openPhoto(file);
  const canvas = document.createElement("canvas");
  try {
    const ctx = drawPhoto(canvas, image, image.naturalWidth, image.naturalHeight, edits);
    release();
    await adjustColour(canvas, ctx, edits);
    // PNG preserves transparency for non-JPEG sources. JPEG uses maximum quality.
    const type = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => result ? resolve(result) : reject(new Error("Could not save this edit.")), type, 1);
    });
    if (blob.size > MAX_UPLOAD_BYTES) {
      throw new Error("The edited copy exceeds 25 MB. Reset its edits or upload the original; it has not been resized.");
    }
    const name = type === "image/jpeg" || file.type === "image/png"
      ? file.name : file.name.replace(/\.[^.]+$/, "") + ".png";
    return new File([blob], name, { type: blob.type, lastModified: file.lastModified });
  } finally {
    release();
    canvas.width = 0;
    canvas.height = 0;
  }
}
