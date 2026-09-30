import { api } from "./api";

type ScanProgress = {
  userId: string | null;
  phase: "idle" | "preparing" | "scanning" | "done" | "error";
  completed: number;
  total: number;
  failed: number;
};

let progress: ScanProgress = { userId: null, phase: "idle", completed: 0, total: 0, failed: 0 };
let running: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: ScanProgress) {
  progress = next;
  for (const listener of listeners) listener();
}

export function autoScanSnapshot() {
  return progress;
}

export function subscribeAutoScan(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Search missing events, or refresh every event after the reference changes. */
export function startAutoScan(userId?: string, refreshAll = false): Promise<void> {
  if (running) {
    if (refreshAll || (userId && progress.userId && userId !== progress.userId)) {
      return running.then(() => startAutoScan(userId, refreshAll));
    }
    return running;
  }
  publish({ userId: userId ?? null, phase: "preparing", completed: 0, total: 0, failed: 0 });
  running = (async () => {
    try {
      const member = await api.me();
      if (!member.onboarded || (userId && member.id !== userId)) {
        publish({ userId: member.id, phase: "idle", completed: 0, total: 0, failed: 0 });
        return;
      }
      const collections = (await api.listCollections()).filter((collection) => collection.photoCount > 0);
      const missing: string[] = [];
      if (refreshAll) {
        missing.push(...collections.map((collection) => collection.id));
      } else {
        for (let i = 0; i < collections.length; i += 4) {
          const batch = collections.slice(i, i + 4);
          const cached = await Promise.all(batch.map((collection) => api.cachedScan(collection.id).catch(() => null)));
          batch.forEach((collection, index) => {
            if (!cached[index]?.scannedAt) missing.push(collection.id);
          });
        }
      }
      publish({ userId: member.id, phase: "scanning", completed: 0, total: missing.length, failed: 0 });
      let failed = 0;
      for (let i = 0; i < missing.length; i += 2) {
        const batch = missing.slice(i, i + 2);
        const results = await Promise.allSettled(batch.map((id) => api.scan(id, true)));
        failed += results.filter((result) => result.status === "rejected").length;
        publish({ userId: member.id, phase: "scanning", completed: i + batch.length, total: missing.length, failed });
      }
      publish({ userId: member.id, phase: failed ? "error" : "done", completed: missing.length, total: missing.length, failed });
    } catch {
      publish({ ...progress, phase: "error", failed: Math.max(progress.failed, 1) });
    }
  })().finally(() => { running = null; });
  return running;
}
