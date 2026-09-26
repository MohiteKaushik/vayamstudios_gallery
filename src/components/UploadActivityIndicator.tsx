import { Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useActiveUploads } from "@/lib/upload-activity";

export function UploadActivityIndicator() {
  const uploads = useActiveUploads();
  if (!uploads.length) return null;

  return (
    <aside
      aria-label="Active photo uploads"
      aria-live="polite"
      className="fixed bottom-24 right-4 z-30 w-[min(22rem,calc(100vw-2rem))] space-y-2 lg:bottom-5"
    >
      {uploads.map((upload) => {
        const total = Math.max(1, upload.progress.total);
        const percent = Math.min(100, Math.round((upload.progress.processed / total) * 100));
        return (
          <Link
            key={upload.id}
            to="/collections"
            search={{ shared: upload.collectionId, ...(upload.eventId ? { event: upload.eventId } : {}) }}
            className="glass-chrome block rounded-2xl border border-hairline p-4 shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <div className="flex items-center gap-3">
              <Loader2 className="size-5 shrink-0 animate-spin" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3 text-sm font-medium">
                  <span className="truncate">Uploading to {upload.collectionName}</span>
                  <span className="shrink-0 tabular-nums">{percent}%</span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
                  <div className="h-full rounded-full bg-primary transition-[width] duration-300"
                    style={{ width: `${percent}%` }} />
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {upload.progress.current
                    ? `${upload.progress.current} · ${upload.progress.processed} of ${upload.progress.total}`
                    : `${upload.progress.processed} of ${upload.progress.total} photos`}
                </p>
              </div>
            </div>
          </Link>
        );
      })}
    </aside>
  );
}
