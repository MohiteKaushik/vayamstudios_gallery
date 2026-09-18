import { ChevronLeft, ChevronRight, Download, ImageOff, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { GlassButton } from "./ui-kit";
import type { ScanHit } from "@/lib/api";

type Result = { hits: ScanHit[]; collectionName: string; truncated: boolean };

export function AdminPhotoPreview({ open, onOpenChange, name, result, busy, message, error, archive, onRetry, onDownload, onCancel }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  result: Result | null;
  busy: boolean;
  message: string;
  error: string;
  archive: { url: string; name: string } | null;
  onRetry: () => void;
  onDownload: (zip: boolean) => void;
  onCancel: () => void;
}) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[90dvh] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto rounded-lg border-hairline p-4 sm:p-6">
      <DialogHeader className="min-w-0 pr-7 text-left">
        <DialogTitle className="break-words leading-snug">Photos of {name}</DialogTitle>
        <DialogDescription>{result?.collectionName || "Matched photo preview"}</DialogDescription>
      </DialogHeader>
      {busy && !result && <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-5 animate-spin" aria-hidden />Finding photos...
      </div>}
      {result && <PreviewPages key={result.hits.map((hit) => hit.photoId).join(",")} photos={result.hits} />}
      <p role="status" aria-live="polite" className="break-words text-sm text-muted-foreground">{message}</p>
      {result?.truncated && <p className="text-sm text-amber-500">The search reached its result limit. Additional matches may exist.</p>}
      {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2 border-t border-hairline pt-4">
        <GlassButton size="sm" icon={<Download className="size-4" />} disabled={busy || !result?.hits.length}
          onClick={() => onDownload(false)}>Download photos</GlassButton>
        <GlassButton size="sm" variant="quiet" icon={<Download className="size-4" />} disabled={busy || !result?.hits.length}
          onClick={() => onDownload(true)}>Download ZIP</GlassButton>
        {busy && <GlassButton size="sm" variant="quiet" icon={<X className="size-4" />} onClick={onCancel}>Cancel</GlassButton>}
        {!busy && (error || !result?.hits.length) && <GlassButton size="sm" variant="quiet"
          icon={<RefreshCw className="size-4" />} onClick={onRetry}>Retry preview</GlassButton>}
      </div>
      {archive && <a href={archive.url} download={archive.name} className="text-sm underline">Save ZIP</a>}
    </DialogContent>
  </Dialog>;
}

function PreviewPages({ photos }: { photos: ScanHit[] }) {
  const [page, setPage] = useState(0);
  const pageSize = 12;
  if (!photos.length) return null;
  const start = page * pageSize;
  return <>
    <div className="grid max-h-[40dvh] grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
      {photos.slice(start, start + pageSize).map((photo) => <PreviewImage key={photo.photoId} photo={photo} />)}
    </div>
    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>{start + 1}-{Math.min(start + pageSize, photos.length)} of {photos.length} matches</span>
      <div className="flex gap-2">
        <button type="button" title="Previous previews" aria-label="Previous previews" disabled={page === 0}
          onClick={() => setPage(page - 1)} className="flex size-10 items-center justify-center rounded-lg bg-secondary disabled:opacity-40">
          <ChevronLeft className="size-4" />
        </button>
        <button type="button" title="Next previews" aria-label="Next previews" disabled={start + pageSize >= photos.length}
          onClick={() => setPage(page + 1)} className="flex size-10 items-center justify-center rounded-lg bg-secondary disabled:opacity-40">
          <ChevronRight className="size-4" />
        </button>
      </div>
    </div>
  </>;
}

function PreviewImage({ photo }: { photo: ScanHit }) {
  const [failed, setFailed] = useState(false);
  return <div className="flex aspect-[4/3] min-w-0 items-center justify-center overflow-hidden rounded-lg bg-secondary">
    {failed ? <span role="img" aria-label={`Preview unavailable: ${photo.fileName}`} title="Preview unavailable">
      <ImageOff className="size-6 text-muted-foreground" />
    </span> : <img src={photo.thumbUrl} alt={photo.fileName} loading="lazy" decoding="async"
      onError={() => setFailed(true)} className="size-full object-contain" />}
  </div>;
}
