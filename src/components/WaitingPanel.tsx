import { useQuery } from "@tanstack/react-query";
import { Clock, Download, MessageCircle, Phone, ScanFace, UserCheck } from "lucide-react";
import { toast } from "sonner";
import { EmptyState, GlassButton, GlassCard, Shimmer } from "@/components/ui-kit";
import { api, type WaitingRow } from "@/lib/api";
import { formatPhone } from "@/lib/members";

/**
 * Who is still waiting to be photographed.
 *
 * A guest pressing Find me and getting nothing is, at a live event, almost
 * never "you are not in the photographs". It is "the photographer has not
 * reached you yet", and that is worth minutes, not a post-event report. So this
 * refreshes on its own while the console is open and puts a WhatsApp and a call
 * button next to each name, because the useful next action is to go and find
 * that person.
 *
 * A name leaves this list the moment one of their searches succeeds.
 */
export function WaitingPanel() {
  const waiting = useQuery({
    queryKey: ["waiting"],
    queryFn: api.listWaiting,
    retry: false,
    // While an event is running this is the screen someone is watching. Ten
    // seconds is fast enough to act on and slow enough to be free.
    refetchInterval: 10_000,
  });

  const rows = waiting.data ?? [];

  function download() {
    if (!rows.length) return;
    const blob = new Blob(["﻿" + waitingToCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vayam-waiting-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Downloaded ${rows.length} row(s)`);
  }

  return (
    <section className="mt-12">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Waiting to be photographed
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {rows.length === 0
              ? "Everyone who has searched has found themselves."
              : `${rows.length} ${rows.length === 1 ? "person has" : "people have"} searched and found nothing yet.`}
          </p>
        </div>
        {rows.length > 0 && (
          <GlassButton variant="quiet" size="sm" icon={<Download className="size-4" />} onClick={download}>
            Download
          </GlassButton>
        )}
      </div>

      {waiting.isLoading ? (
        <Shimmer className="h-24" />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<UserCheck className="size-7" strokeWidth={1.5} />}
          title="Nobody is waiting"
          description="This list fills up on its own when someone searches an event and comes up empty."
        />
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={`${r.collectionId}:${r.userId}`}>
              <GlassCard className="flex flex-wrap items-center gap-4 px-5 py-4">
                <div className="min-w-0 flex-1">
                  {/* An operator account has no name on it, and a blank row is
                      a row nobody can act on. */}
                  <p className="truncate font-medium tracking-[-0.01em]">
                    {r.fullName || r.email || "Unnamed member"}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {r.collectionName} · {formatPhone(r.phone)} · {r.email}
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <Clock className="size-3" />
                      {sinceText(r.lastAskedAt)}
                      {r.attempts > 1 ? ` · tried ${r.attempts} times` : ""}
                    </span>
                    {!r.hasReference && (
                      <span className="inline-flex items-center gap-1 text-amber-500">
                        <ScanFace className="size-3" />
                        no reference photo yet
                      </span>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <a
                    href={`https://wa.me/91${r.phone.replace(/\D/g, "").slice(-10)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`WhatsApp ${r.fullName}`}
                    className="press flex size-9 items-center justify-center rounded-full bg-secondary text-muted-foreground hover:text-foreground"
                  >
                    <MessageCircle className="size-4" strokeWidth={1.6} />
                  </a>
                  <a
                    href={`tel:+91${r.phone.replace(/\D/g, "").slice(-10)}`}
                    aria-label={`Call ${r.fullName}`}
                    className="press flex size-9 items-center justify-center rounded-full bg-secondary text-muted-foreground hover:text-foreground"
                  >
                    <Phone className="size-4" strokeWidth={1.6} />
                  </a>
                </div>
              </GlassCard>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** "4 minutes ago", which is the only part of a timestamp anyone acts on here. */
function sinceText(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * A leading =, +, - or @ makes a spreadsheet treat a cell as a formula, so a
 * name starting with one is neutralised rather than executed on open.
 */
function csvCell(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function waitingToCsv(rows: WaitingRow[]): string {
  const header = ["Name", "Phone", "Email", "Event", "First asked", "Last asked", "Attempts", "Has reference photo"];
  const lines = rows.map((r) =>
    [
      r.fullName,
      r.phone,
      r.email,
      r.collectionName,
      new Date(r.firstAskedAt).toISOString(),
      new Date(r.lastAskedAt).toISOString(),
      String(r.attempts),
      r.hasReference ? "yes" : "no",
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.map(csvCell).join(","), ...lines].join("\r\n");
}
