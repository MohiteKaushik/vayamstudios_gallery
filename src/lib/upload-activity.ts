import { useSyncExternalStore } from "react";
import type { BulkProgress } from "./upload";

export type UploadActivity = {
  id: string;
  collectionId: string;
  collectionName: string;
  eventId?: string;
  progress: BulkProgress;
  startedAt: number;
};

type UploadTracker = {
  report: (progress: BulkProgress) => void;
  finish: () => void;
};

const jobs = new Map<string, UploadActivity>();
const listeners = new Set<() => void>();
const EMPTY: readonly UploadActivity[] = [];
let snapshot: readonly UploadActivity[] = EMPTY;

function publish() {
  snapshot = [...jobs.values()];
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getActiveUploads(): readonly UploadActivity[] {
  return snapshot;
}

export function beginPhotoUpload(input: {
  collectionId: string;
  collectionName: string;
  eventId?: string;
  total: number;
}): UploadTracker {
  if (jobs.has(input.collectionId)) throw new Error("Photos are already uploading to this subfolder");
  const id = crypto.randomUUID();
  const activity: UploadActivity = {
    id,
    collectionId: input.collectionId,
    collectionName: input.collectionName,
    ...(input.eventId ? { eventId: input.eventId } : {}),
    progress: {
      processed: 0,
      total: input.total,
      faces: 0,
      indexed: 0,
      failed: 0,
      bytesIn: 0,
      bytesOut: 0,
      indexPending: 0,
    },
    startedAt: Date.now(),
  };
  jobs.set(input.collectionId, activity);
  publish();

  return {
    report(progress) {
      const current = jobs.get(input.collectionId);
      if (current?.id !== id) return;
      jobs.set(input.collectionId, { ...current, progress: { ...progress } });
      publish();
    },
    finish() {
      if (jobs.get(input.collectionId)?.id !== id) return;
      jobs.delete(input.collectionId);
      publish();
    },
  };
}

export function useActiveUploads(): readonly UploadActivity[] {
  return useSyncExternalStore(subscribe, getActiveUploads, () => EMPTY);
}

export function useUploadActivity(collectionId: string): UploadActivity | null {
  const uploads = useActiveUploads();
  return uploads.find((upload) => upload.collectionId === collectionId) ?? null;
}
