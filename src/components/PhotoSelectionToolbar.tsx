import { CheckCheck, Download, X } from "lucide-react";
import type { GridPhoto } from "@/components/PhotoGrid";
import { GlassButton } from "@/components/ui-kit";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { formatCount } from "@/lib/images";
import { usePhotoDownload } from "@/lib/use-photo-download";

export function PhotoSelectionToolbar({
  photos,
  total,
  label,
  onClear,
  onSelectAll,
}: {
  photos: GridPhoto[];
  total: number;
  label: string;
  onClear: () => void;
  onSelectAll: () => void;
}) {
  const download = usePhotoDownload(photos, label);

  if (!photos.length) return null;

  return (
    <div className="glass-chrome rise-in sticky top-20 z-30 mb-5 rounded-lg border px-3 py-3 shadow-[var(--shadow-lifted)]">
      <div role="toolbar" aria-label="Selected photos" className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={onClear}
            aria-label="Exit photo selection"
            className="press flex size-9 shrink-0 items-center justify-center rounded-full hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-4" />
          </button>
          <span className="truncate text-sm font-medium">{formatCount(photos.length, "photo")} selected</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {photos.length < total && (
            <GlassButton
              type="button"
              variant="ghost"
              size="sm"
              icon={<CheckCheck className="size-4" />}
              onClick={onSelectAll}
              className="hidden sm:inline-flex"
            >
              Select all
            </GlassButton>
          )}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <GlassButton
                type="button"
                size="sm"
                loading={download.downloading}
                icon={<Download className="size-4" />}
              >
                Download
              </GlassButton>
            </AlertDialogTrigger>
            <AlertDialogContent className="w-[calc(100%-2rem)] rounded-lg">
              <AlertDialogHeader>
                <AlertDialogTitle>Download selected photos?</AlertDialogTitle>
                <AlertDialogDescription className="leading-relaxed">
                  Some photos may include other attendees. Please review them before sharing or uploading, and respect everyone&apos;s privacy.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => void download.start()} className="gap-2">
                  <Download className="size-4" /> Download {photos.length}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
      {download.message ? <p aria-live="polite" className="mt-2 text-right text-xs text-muted-foreground">{download.message}</p> : null}
    </div>
  );
}
