import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, FlipHorizontal2, FlipVertical2, Grid3X3, ImageOff, Loader2, RotateCcw, RotateCw, Sparkles, Undo2, Upload } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { GlassButton } from "@/components/ui-kit";
import { createEditPreview, hasPhotoEdits, ORIGINAL_EDITS, renderEditPreview, type PhotoEdits } from "@/lib/photo-edits";

export default function PhotoUploadEditor({ files, onCancel, onUpload }: {
  files: File[];
  onCancel: () => void;
  onUpload: (edits: ReadonlyMap<File, PhotoEdits>) => void;
}) {
  const [index, setIndex] = useState(0);
  const [edits, setEdits] = useState<Map<File, PhotoEdits>>(() => new Map());
  const [original, setOriginal] = useState(false);
  const [grid, setGrid] = useState(false);
  const file = files[index]!;
  const current = edits.get(file) ?? ORIGINAL_EDITS;

  function update(change: Partial<PhotoEdits>) {
    setOriginal(false);
    setEdits((previous) => {
      const next = new Map(previous);
      const value = { ...(previous.get(file) ?? ORIGINAL_EDITS), ...change };
      if (hasPhotoEdits(value)) next.set(file, value);
      else next.delete(file);
      return next;
    });
  }

  function cancel() {
    if (!edits.size || window.confirm("Discard your edits and cancel this upload?")) onCancel();
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) cancel(); }}>
      <DialogContent className="max-h-[94dvh] w-[calc(100%-1rem)] max-w-5xl overflow-y-auto rounded-lg p-4 sm:p-6" onInteractOutside={(event) => event.preventDefault()}>
        <DialogHeader className="pr-7 text-left">
          <DialogTitle>Edit photos</DialogTitle>
          <DialogDescription>Unedited photos keep their original files. Edited copies keep full resolution.</DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 items-center gap-2 border-b border-hairline pb-3">
          <IconButton label="Previous photo" disabled={index === 0} onClick={() => { setIndex(index - 1); setOriginal(false); }}><ChevronLeft className="size-5" /></IconButton>
          <div className="min-w-0 flex-1 text-center">
            <p className="truncate text-sm font-medium" title={file.name}>{file.name}</p>
            <p className="text-xs text-muted-foreground" aria-live="polite">{index + 1} of {files.length} {edits.has(file) ? " / Edited" : " / Original"}</p>
          </div>
          <IconButton label="Next photo" disabled={index === files.length - 1} onClick={() => { setIndex(index + 1); setOriginal(false); }}><ChevronRight className="size-5" /></IconButton>
        </div>
        <div className="grid min-w-0 gap-5 md:grid-cols-[minmax(0,1fr)_15rem]">
          <Preview key={index} file={file} edits={original ? ORIGINAL_EDITS : current} grid={grid} />
          <div className="min-w-0 space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <IconButton label="Rotate left" onClick={() => update({ rotation: (current.rotation + 270) % 360 })}><RotateCcw className="size-5" /></IconButton>
              <IconButton label="Rotate right" onClick={() => update({ rotation: (current.rotation + 90) % 360 })}><RotateCw className="size-5" /></IconButton>
              <IconButton label="Flip horizontally" pressed={current.flip} onClick={() => update({ flip: !current.flip })}><FlipHorizontal2 className="size-5" /></IconButton>
              <IconButton label="Flip vertically" pressed={current.flipVertical} onClick={() => update({ flipVertical: !current.flipVertical })}><FlipVertical2 className="size-5" /></IconButton>
              <IconButton label="Alignment grid" pressed={grid} onClick={() => setGrid(!grid)}><Grid3X3 className="size-5" /></IconButton>
              <IconButton label="Reset this photo" disabled={!edits.has(file)} onClick={() => update(ORIGINAL_EDITS)}><Undo2 className="size-5" /></IconButton>
            </div>
            <div className="space-y-2">
              <TiltControl value={current.tilt} onChange={(tilt) => update({ tilt })} />
              <p className="text-xs text-muted-foreground">Tilting trims the edges to avoid empty corners.</p>
            </div>
            <GlassButton type="button" variant="quiet" full icon={<Sparkles className="size-4" />}
              onClick={() => update({ brightness: 105, contrast: 108, saturation: 110 })}>Enhance</GlassButton>
            <div className="space-y-4">
              <Adjustment label="Brightness" value={current.brightness} min={50} max={150} onChange={(brightness) => update({ brightness })} />
              <Adjustment label="Contrast" value={current.contrast} min={50} max={150} onChange={(contrast) => update({ contrast })} />
              <Adjustment label="Saturation" value={current.saturation} min={0} max={200} onChange={(saturation) => update({ saturation })} />
            </div>
            <details className="border-t border-hairline pt-3">
              <summary className="cursor-pointer text-sm font-medium">More adjustments</summary>
              <div className="mt-4 space-y-4">
                <Adjustment label="Warmth" value={current.warmth} min={-50} max={50} unit="" onChange={(warmth) => update({ warmth })} />
                <Adjustment label="Shadows" value={current.shadows} min={0} max={100} unit="" onChange={(shadows) => update({ shadows })} />
              </div>
            </details>
            <div className="flex rounded-lg border border-hairline p-1" role="group" aria-label="Compare photo">
              <button type="button" aria-pressed={!original} onClick={() => setOriginal(false)} className={`min-h-10 flex-1 rounded-md text-sm ${!original ? "bg-secondary" : "text-muted-foreground"}`}>Edited</button>
              <button type="button" aria-pressed={original} onClick={() => setOriginal(true)} className={`min-h-10 flex-1 rounded-md text-sm ${original ? "bg-secondary" : "text-muted-foreground"}`}>Original</button>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-4">
          <p className="text-sm text-muted-foreground">{edits.size} edited / {files.length - edits.size} original</p>
          <div className="flex flex-wrap gap-2">
            <GlassButton type="button" variant="ghost" onClick={cancel}>Cancel</GlassButton>
            <GlassButton type="button" icon={<Upload className="size-4" />} onClick={() => onUpload(new Map(edits))}>
              Upload {files.length} {files.length === 1 ? "photo" : "photos"}
            </GlassButton>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function IconButton({ label, disabled, pressed, onClick, children }: {
  label: string; disabled?: boolean; pressed?: boolean; onClick: () => void; children: ReactNode;
}) {
  return <button type="button" title={label} aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}
    className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-hairline bg-secondary transition-colors hover:bg-muted aria-pressed:bg-primary aria-pressed:text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-35">
    {children}
  </button>;
}

function TiltControl({ value, onChange }: { value: number; onChange: (angle: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return <div className="text-sm">
    <div className="flex items-center justify-between gap-2">
      <label htmlFor="photo-tilt-angle">Tilt</label>
      <div className="flex items-center gap-1">
        <input id="photo-tilt-angle" aria-label="Tilt angle in degrees" title="Angle from -45 to 45 degrees"
          type="number" inputMode="decimal" min={-45} max={45} step={0.1} value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
          onBlur={() => {
            const number = draft.trim() ? Number(draft) : value;
            const angle = Number.isFinite(number) ? Math.round(Math.max(-45, Math.min(45, number)) * 10) / 10 : value;
            setDraft(String(angle)); onChange(angle);
          }}
          className="h-9 w-20 rounded-md border border-hairline bg-secondary px-2 text-right tabular-nums" />
        <span aria-hidden="true">{"\u00b0"}</span>
      </div>
    </div>
    <input aria-label="Tilt" aria-valuetext={`${value} degrees`} className="mt-2 h-6 w-full accent-primary"
      type="range" min={-45} max={45} step={0.1} value={value} onChange={(event) => onChange(Number(event.target.value))} />
  </div>;
}

function Adjustment({ label, value, min, max, unit = "%", onChange }: {
  label: string; value: number; min: number; max: number; unit?: string; onChange: (value: number) => void;
}) {
  return <label className="block text-sm">
    <span className="flex justify-between gap-2"><span>{label}</span><output className="tabular-nums text-muted-foreground">{value}{unit}</output></span>
    <input aria-label={label} className="mt-2 h-6 w-full accent-primary" type="range" min={min} max={max} step={1} value={value} onChange={(event) => onChange(Number(event.target.value))} />
  </label>;
}

function Preview({ file, edits, grid }: { file: File; edits: Readonly<PhotoEdits>; grid: boolean }) {
  const target = useRef<HTMLCanvasElement>(null);
  const [source, setSource] = useState<HTMLCanvasElement | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    let preview: HTMLCanvasElement | null = null;
    void createEditPreview(file).then((canvas) => {
      preview = canvas;
      if (disposed) { canvas.width = 0; canvas.height = 0; }
      else setSource(canvas);
    }).catch((reason: unknown) => {
      if (!disposed) setError(reason instanceof Error ? reason.message : "Could not preview this photo.");
    });
    return () => {
      disposed = true;
      if (preview) { preview.width = 0; preview.height = 0; }
    };
  }, [file]);
  useEffect(() => {
    if (!source || !target.current) return;
    const controller = new AbortController();
    const canvas = target.current;
    const frame = requestAnimationFrame(() => {
      void renderEditPreview(canvas, source, edits, controller.signal).catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not preview this edit.");
      });
    });
    return () => { cancelAnimationFrame(frame); controller.abort(); };
  }, [source, edits]);
  return <div className="relative flex aspect-[4/3] min-w-0 items-center justify-center overflow-hidden rounded-lg bg-black md:sticky md:top-0 md:self-start">
    <canvas ref={target} aria-label={`Preview of ${file.name}`} role="img" className={`absolute inset-0 h-full w-full object-contain ${source && !error ? "" : "invisible"}`} />
    {grid && source && !error && <div aria-hidden="true" data-testid="alignment-grid" className="pointer-events-none absolute inset-0">
      {[1, 2].map((line) => <div key={line}>
        <span className="absolute inset-y-0 w-px bg-white/50 shadow-sm" style={{ left: `${line * 100 / 3}%` }} />
        <span className="absolute inset-x-0 h-px bg-white/50 shadow-sm" style={{ top: `${line * 100 / 3}%` }} />
      </div>)}
    </div>}
    {error ? <p role="alert" className="flex max-w-sm flex-col items-center gap-3 p-5 text-center text-sm text-muted-foreground"><ImageOff className="size-7" />{error}</p>
      : !source ? <Loader2 aria-label="Loading photo preview" className="size-6 animate-spin" /> : null}
  </div>;
}
