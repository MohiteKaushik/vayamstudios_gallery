/**
 * Reading an event's photographs again with the current recogniser.
 *
 * A face record in R2 holds the numbers a model produced, and those numbers
 * only mean anything to the model that made them. When the recogniser changed
 * from face-api's 128-number descriptor to ArcFace's 512, every stored face
 * became unreadable: not wrong, but describing a different space entirely, so
 * comparing across the two would quietly match nothing at all.
 *
 * The photographs themselves are untouched and still in R2, so nothing needs
 * re-uploading. This fetches each one back, looks at it again, and overwrites
 * the face record. An event of a few hundred photographs takes a few minutes on
 * a laptop; forty thousand is an afternoon, which is why it reports progress and
 * can be stopped and resumed. Stopping leaves the collection half-converted,
 * which is safe: a photograph is either fully described by the new model or
 * still described by the old one, and the old ones simply never match until
 * their turn comes.
 */

import { detectFacesThorough } from "./face";
import { downscale, fileToImage } from "./images";
import { api } from "./api";
import { STORE_MAX_EDGE, type BulkProgress } from "./upload";

export type ReanalyseProgress = BulkProgress & {
  /** Photographs whose faces are already in the current model's terms. */
  skipped: number;
};

/**
 * Reads one photograph again and replaces its face record.
 *
 * The image comes from /media/p, the same route the grid uses, so it is the
 * stored copy rather than the original the photographer handed over. That is
 * the right one: it is what every later scan will be compared against, and it
 * is what the first indexing pass saw.
 */
async function reanalysePhoto(collectionId: string, photoId: string): Promise<number> {
  const res = await fetch(`/media/p/${collectionId}/${photoId}`, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`Could not read the photo back (${res.status})`);
  const img = await fileToImage(new File([await res.blob()], photoId));

  const stored = downscale(img, STORE_MAX_EDGE);
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

  const indexed = await fetch("/media/index", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ collection: collectionId, photoId, faces }),
  });
  if (!indexed.ok) {
    const body = (await indexed.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `The index refused this photo (${indexed.status})`);
  }
  return faces.length;
}

/**
 * Walks a whole collection.
 *
 * One photograph at a time, deliberately. Detection is several model passes and
 * is the slow step; running ten at once contends for the same cores, finishes no
 * sooner, and makes the browser unusable while it does.
 */
export async function reanalyseCollection(opts: {
  collectionId: string;
  onProgress: (p: ReanalyseProgress) => void;
  signal?: AbortSignal;
}): Promise<ReanalyseProgress> {
  const { collectionId, onProgress } = opts;

  const photos = await api.allPhotos(collectionId);
  const p: ReanalyseProgress = {
    processed: 0,
    total: photos.length,
    faces: 0,
    indexed: 0,
    failed: 0,
    skipped: 0,
    bytesIn: 0,
    bytesOut: 0,
    indexPending: 0,
  };
  onProgress({ ...p });

  for (const photo of photos) {
    if (opts.signal?.aborted) break;
    p.current = photo.fileName;
    onProgress({ ...p });
    try {
      p.faces += await reanalysePhoto(collectionId, photo.id);
    } catch (e) {
      p.failed++;
      // Only the first reason is kept. A collection where every photograph
      // fails the same way produces one useful sentence, not four hundred.
      if (!p.firstError) p.firstError = e instanceof Error ? e.message : String(e);
    }
    p.processed++;
    onProgress({ ...p });
  }

  p.indexed = p.faces;
  onProgress({ ...p });
  return p;
}

/**
 * Keeps indexing whatever arrives, for as long as the tab is open.
 *
 * During an event the photographs come off a camera and are pushed up by the
 * watcher script in tools/. That script cannot look at them: face detection
 * needs a canvas and a model, and it runs here, in a browser. So it uploads,
 * and this watches for photographs with no face record and reads them.
 *
 * The two halves are deliberately independent. The uploading laptop may not be
 * yours, and this only needs a console signed in somewhere with the tab left
 * open. Nothing is lost if it is closed; the photographs are already stored and
 * the next run picks up exactly where this stopped.
 */
export async function keepIndexing(opts: {
  collectionId: string;
  onProgress: (p: ReanalyseProgress) => void;
  onIdle: (waitingFor: number) => void;
  signal: AbortSignal;
  pollMs?: number;
}): Promise<void> {
  const { collectionId, onProgress, onIdle, signal, pollMs = 6000 } = opts;

  while (!signal.aborted) {
    const pending = await api.unindexedPhotos(collectionId).catch(() => null);
    if (signal.aborted) return;

    if (!pending || pending.photoIds.length === 0) {
      onIdle(pending?.indexed ?? 0);
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }

    const p: ReanalyseProgress = {
      processed: 0,
      total: pending.photoIds.length,
      faces: 0,
      indexed: 0,
      failed: 0,
      skipped: 0,
      bytesIn: 0,
      bytesOut: 0,
      indexPending: 0,
    };
    onProgress({ ...p });

    for (const photoId of pending.photoIds) {
      if (signal.aborted) return;
      try {
        p.faces += await reanalysePhoto(collectionId, photoId);
      } catch (e) {
        p.failed++;
        if (!p.firstError) p.firstError = e instanceof Error ? e.message : String(e);
      }
      p.processed++;
      p.indexed = p.faces;
      onProgress({ ...p });
    }
  }
}
