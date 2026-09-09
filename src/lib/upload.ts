/**
 * Admin upload, from the browser to R2 and the face index.
 *
 * Three requests per photo, in this order:
 *
 *   1. the stored image      POST /media/upload
 *   2. a grid thumbnail      POST /media/upload?kind=thumb
 *   3. the faces found in it POST /media/index
 *
 * The thumbnail is the reason a gallery of forty thousand photos opens quickly.
 * A grid showing two hundred tiles at full size would pull hundreds of
 * megabytes; the same grid on thumbnails pulls a few. The full image is only
 * fetched when someone actually opens one.
 *
 * Face detection stays in the browser, so the photograph itself never leaves
 * the machine for analysis and the server only ever receives 128 numbers per
 * face. That also means the work scales with the number of admins uploading
 * rather than costing Worker processor time.
 */

import { supabase } from "@/integrations/supabase/client";
import { detectFacesThorough } from "./face";
import { encodeImage, savingsPercent } from "./encode";
import { downscale, fileToImage } from "./images";

/**
 * Trades the sign-in the app currently uses for a session the Worker accepts.
 *
 * Needed because the migration is mid-flight: storage moved to R2 before
 * sign-in did, so without this every upload is refused by a Worker that has
 * never heard of the caller. Runs once per batch, not once per photo.
 *
 * Goes away when sign-in itself moves across.
 */
let sessionReady: Promise<void> | null = null;

export async function ensureUploadSession(force = false): Promise<void> {
  if (force) sessionReady = null;
  if (!sessionReady) {
    sessionReady = (async () => {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("You are signed out. Sign in again and retry.");

      const res = await fetch("/media/session", {
        method: "POST",
        credentials: "same-origin",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        sessionReady = null;
        throw new Error(await readError(res, "Could not start an upload session"));
      }
      const who = (await res.json()) as { role?: string };
      if (who.role !== "admin") {
        sessionReady = null;
        throw new Error("This account is not an operator, so it cannot upload.");
      }
    })();
  }
  return sessionReady;
}

/** Long edge of the stored image. */
export const STORE_MAX_EDGE = 2048;
/** Long edge of the grid thumbnail. */
export const THUMB_MAX_EDGE = 512;

export type UploadedPhoto = {
  photoId: string;
  bytesIn: number;
  bytesOut: number;
  /** Faces detected in the photo and stored in R2. */
  faces: number;
  /** Of those, how many reached the search index. */
  indexed: number;
  /** True when the faces are stored but not yet searchable. */
  indexPending: boolean;
};

async function postBytes(
  url: string,
  blob: Blob,
  headers: Record<string, string>,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    // The session cookie is what authorises this; it must be sent.
    credentials: "same-origin",
    headers: { "content-type": blob.type, ...headers },
    body: blob,
  });
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Stores one photo and indexes its faces.
 *
 * The full image is uploaded before anything else, so a failure part-way
 * through leaves a viewable photo rather than an orphaned record. Faces are
 * indexed last for the same reason.
 */
export async function uploadPhoto(opts: {
  collectionId: string;
  file: File;
  onStep?: (step: "encoding" | "storing" | "detecting" | "indexing") => void;
  signal?: AbortSignal;
}): Promise<UploadedPhoto> {
  const { collectionId, file, onStep } = opts;

  onStep?.("encoding");
  const img = await fileToImage(file);
  const stored = downscale(img, STORE_MAX_EDGE);
  const encoded = await encodeImage(stored.canvas);

  onStep?.("storing");
  const created = await postBytes(
    `/media/upload?collection=${encodeURIComponent(collectionId)}`,
    encoded.blob,
    {
      "x-file-name": file.name,
      "x-width": String(stored.canvas.width),
      "x-height": String(stored.canvas.height),
    },
  );
  if (!created.ok) throw new Error(await readError(created, "Could not store the photo"));
  const { photoId } = (await created.json()) as { photoId: string };

  // A thumbnail failing is not worth losing the photo over; the grid can fall
  // back to the full image for that one.
  const thumb = downscale(img, THUMB_MAX_EDGE);
  const thumbEncoded = await encodeImage(thumb.canvas);
  await postBytes(
    `/media/upload?collection=${encodeURIComponent(collectionId)}&photo=${photoId}&kind=thumb`,
    thumbEncoded.blob,
    {},
  ).catch(() => undefined);

  onStep?.("detecting");
  // Several passes over the frame. A single downscaled pass loses every face
  // that is small in the original, and a face never detected can never match.
  const analysis = await detectFacesThorough(img);
  const scale = stored.canvas.width / analysis.canvas.width;
  const faces = analysis.faces.map((f) => ({
    descriptor: f.descriptor,
    score: f.score,
    box: {
      x: Math.round(f.box.x * scale),
      y: Math.round(f.box.y * scale),
      width: Math.round(f.box.width * scale),
      height: Math.round(f.box.height * scale),
    },
  }));

  onStep?.("indexing");
  const indexed = await fetch("/media/index", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ collection: collectionId, photoId, faces }),
  });

  let indexPending = false;
  let indexedCount = 0;
  if (!indexed.ok) {
    indexPending = faces.length > 0;
  } else {
    const result = (await indexed.json()) as { warning?: string; indexed?: number };
    indexedCount = result.indexed ?? 0;
    indexPending = faces.length > 0 && indexedCount === 0;
  }

  return {
    photoId,
    bytesIn: file.size,
    bytesOut: encoded.blob.size + thumbEncoded.blob.size,
    faces: faces.length,
    indexed: indexedCount,
    indexPending,
  };
}

export type BulkProgress = {
  processed: number;
  total: number;
  /** Faces detected and stored. */
  faces: number;
  /** Of those, how many are searchable. Reporting only the first is how
   *  "7 faces indexed" appeared when none of them actually were. */
  indexed: number;
  failed: number;
  bytesIn: number;
  bytesOut: number;
  indexPending: number;
  current?: string;
  /**
   * Why the first failure happened.
   *
   * Reporting "added 0 photos" with no reason, which is what this did before,
   * is the worst possible outcome: it looks like the upload worked and found
   * nothing, when in fact every single one was refused.
   */
  firstError?: string;
};

/**
 * Uploads a batch, one photo at a time.
 *
 * Sequential on purpose. Detection runs several model passes per photo and is
 * the slow step; firing ten at once would contend for the same GPU and finish
 * no sooner, while making the progress figures meaningless and the browser
 * unresponsive.
 */
export async function uploadPhotos(opts: {
  collectionId: string;
  files: File[];
  onProgress: (p: BulkProgress) => void;
  signal?: AbortSignal;
}): Promise<BulkProgress> {
  const { collectionId, files, onProgress } = opts;
  const p: BulkProgress = {
    processed: 0,
    total: files.length,
    faces: 0,
    indexed: 0,
    failed: 0,
    bytesIn: 0,
    bytesOut: 0,
    indexPending: 0,
  };
  onProgress({ ...p });

  // One handshake for the whole batch. If it fails, every photo would fail for
  // the same reason, so say so once instead of failing a thousand times.
  try {
    await ensureUploadSession();
  } catch (e) {
    p.firstError = e instanceof Error ? e.message : "Could not start an upload session";
    p.failed = files.length;
    p.processed = files.length;
    onProgress({ ...p });
    return p;
  }

  for (const file of files) {
    if (opts.signal?.aborted) break;
    p.current = file.name;
    onProgress({ ...p });
    try {
      const r = await uploadPhoto({
        collectionId,
        file,
        ...(opts.signal ? { signal: opts.signal } : {}),
        onStep: () => onProgress({ ...p }),
      });
      p.faces += r.faces;
      p.indexed += r.indexed;
      p.bytesIn += r.bytesIn;
      p.bytesOut += r.bytesOut;
      if (r.indexPending) p.indexPending += 1;
    } catch (e) {
      console.error(file.name, e);
      p.failed += 1;
      p.firstError ??= e instanceof Error ? e.message : String(e);
    }
    p.processed += 1;
    onProgress({ ...p });
  }

  return p;
}

/** How much smaller the stored copies are than what was handed in. */
export const uploadSavings = (p: BulkProgress) => savingsPercent(p.bytesIn, p.bytesOut);
