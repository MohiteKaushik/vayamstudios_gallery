import { Camera, ImagePlus, ScanFace } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { GlassButton } from "@/components/ui-kit";
import { enrolFace } from "@/lib/enroll";
import { onEngineProgress } from "@/lib/face";

/**
 * Asking for a reference photo at the moment it is first needed.
 *
 * It used to be the first thing a new member saw, before they had seen a single
 * photograph. Most people arriving from an event want to look at the event
 * first and find themselves afterwards, and being asked to hand over a selfie
 * by a page that has shown you nothing yet is a reason to close the tab. So the
 * ask now happens here, the first time someone presses Find me, when what it is
 * for is obvious.
 *
 * Two ways in, because on a phone they are genuinely different actions: the
 * camera, through capture="user", and the photos already on the device.
 */
export function FaceEnrolSheet({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // The recogniser is about 16 MB and downloads the first time anyone uses it.
  // On event wifi that is a real wait, and a button that says nothing for
  // twenty seconds is a button people press again.
  const [downloaded, setDownloaded] = useState<{ loaded: number; total: number } | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    void onEngineProgress((loaded, total) => {
      if (!cancelled) setDownloaded(total > 0 && loaded < total ? { loaded, total } : null);
    }).then((off) => {
      if (cancelled) off();
      else stop = off;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function pick(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      const { error } = await enrolFace(file);
      if (error) toast.error(error);
      else {
        toast.success("Face profile saved");
        onDone();
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Add a reference photo of yourself"
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 px-5 pb-5 backdrop-blur-sm sm:items-center sm:pb-0"
      onClick={() => !busy && onClose()}
    >
      <div
        className="glass-surface w-full max-w-sm rounded-3xl p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col items-center text-center">
          <ScanFace className="mb-4 size-8" strokeWidth={1.4} />
          <h2 className="text-lg font-semibold tracking-[-0.02em]">
            A photo of you, so we know who to look for
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            A clear, front-facing shot works best. It is analysed on your device, and a small crop
            is kept so the team can find you if you have not been photographed yet. You can replace
            or remove it any time from Settings.
          </p>
        </div>

        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="user"
          className="hidden"
          onChange={(e) => pick(e.target.files?.[0])}
        />
        <input
          ref={libraryRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => pick(e.target.files?.[0])}
        />

        <div className="mt-6 space-y-2">
          <GlassButton
            full
            size="lg"
            loading={busy}
            icon={<Camera className="size-4" />}
            onClick={() => cameraRef.current?.click()}
          >
            {downloaded
              ? `Getting ready… ${Math.round((downloaded.loaded / downloaded.total) * 100)}%`
              : busy
                ? "Looking for your face…"
                : "Take a photo"}
          </GlassButton>
          <GlassButton
            full
            variant="quiet"
            size="lg"
            disabled={busy}
            icon={<ImagePlus className="size-4" />}
            onClick={() => libraryRef.current?.click()}
          >
            Choose an existing photo
          </GlassButton>
          <button
            onClick={onClose}
            disabled={busy}
            className="press w-full rounded-full py-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
