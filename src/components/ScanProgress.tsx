import { useEffect, useRef, useState } from "react";
import { GlassCard } from "@/components/ui-kit";
import { formatCount } from "@/lib/images";
import type { Progress } from "@/lib/pipeline";

function fmtTime(ms: number) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s left`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s left`;
}

/**
 * Refined glass progress surface used for every long-running analysis:
 * a thin progress ring, live counters and an estimate of remaining time.
 */
export function ScanProgress({
  progress,
  title = "Finding your photos",
  subtitle,
}: {
  progress: Progress;
  title?: string;
  subtitle?: string;
}) {
  const total = Math.max(1, progress.total);
  const pct = Math.min(100, (progress.processed / total) * 100);
  const start = useRef<number>(Date.now());
  const [eta, setEta] = useState<string | null>(null);

  useEffect(() => {
    if (progress.processed < 1 || progress.processed >= progress.total) {
      setEta(null);
      return;
    }
    const elapsed = Date.now() - start.current;
    const per = elapsed / progress.processed;
    setEta(fmtTime(per * (progress.total - progress.processed)));
  }, [progress.processed, progress.total]);

  const R = 46;
  const C = 2 * Math.PI * R;

  return (
    <GlassCard className="rise-in p-8 sm:p-10">
      <div className="flex flex-col items-center gap-8 sm:flex-row sm:items-center sm:gap-10">
        <div className="relative shrink-0">
          <svg viewBox="0 0 110 110" className="size-28 -rotate-90" aria-hidden>
            <circle cx="55" cy="55" r={R} fill="none" stroke="currentColor" strokeWidth="3" className="text-secondary" />
            <circle
              cx="55"
              cy="55"
              r={R}
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              className="text-primary transition-[stroke-dashoffset] duration-500 ease-out"
              strokeDasharray={C}
              strokeDashoffset={C - (C * pct) / 100}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-xl font-semibold tabular-nums tracking-[-0.03em]">{Math.round(pct)}%</span>
          </div>
        </div>

        <div className="min-w-0 flex-1 text-center sm:text-left">
          <h2 className="text-xl font-semibold tracking-[-0.03em]">{title}</h2>
          <p
            className="mt-1 text-sm text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            {subtitle ??
              `Scanning ${Math.min(progress.processed + 1, progress.total)} of ${progress.total}`}
            {eta ? ` · ${eta}` : ""}
          </p>

          <div className="mt-5 grid grid-cols-3 gap-3">
            <Stat label="Analysed" value={progress.processed} />
            <Stat label="Faces" value={progress.faces} />
            <Stat label="Matches" value={progress.matches} />
          </div>

          {progress.failed > 0 && (
            <p className="mt-4 text-xs text-muted-foreground">
              {formatCount(progress.failed, "photo")} couldn't be analysed and were skipped.
            </p>
          )}
        </div>
      </div>
    </GlassCard>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl bg-secondary/60 px-3 py-3 text-center sm:text-left sm:px-4">
      <p className="text-lg font-semibold tabular-nums tracking-[-0.02em]">{value}</p>
      <p className="text-[0.7rem] uppercase tracking-[0.1em] text-muted-foreground">{label}</p>
    </div>
  );
}
