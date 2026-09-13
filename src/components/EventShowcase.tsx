import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronLeft, Globe, Mail, MessageCircle, Pencil, Phone } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { GlassButton, GlassCard } from "@/components/ui-kit";
import { api } from "@/lib/api";
import { contact, events, eventSubtitle, shownTitle, type EventRenames, type VayamEvent } from "@/lib/vayam";

function useRenames() {
  return useQuery({ queryKey: ["past-events"], retry: false, queryFn: api.pastEventRenames });
}

/**
 * The studio's past work, shown to a member once their face profile is set up.
 *
 * Choosing an event does not open photos. It opens a way to reach the team,
 * which is the point: a member browsing this is a prospective client looking at
 * what VAYAM has run, and the next step is a conversation.
 */
export function EventShowcase({ editable = false }: { editable?: boolean }) {
  const [selected, setSelected] = useState<VayamEvent | null>(null);
  const renames = useRenames().data;

  // Escape closes the panel, matching every other layer in the app.
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  if (selected) return <EventDetail event={selected} renames={renames} onBack={() => setSelected(null)} />;

  return (
    <section className="mt-14">
      <h2 className="mb-1 text-sm font-medium uppercase tracking-[0.12em] text-muted-foreground">
        Events we have run
      </h2>
      <p className="mb-5 text-sm text-muted-foreground">
        {editable
          ? "Members see this list on their home page. Press the pencil to rename an event."
          : "Select any of these to talk to the team about your own."}
      </p>

      <ul className="space-y-2">
        {/* Newest first. The studio's own list runs oldest to newest, and that
            order is kept in vayam.ts because it is theirs; it is only reversed
            for display, so the most recent work is what a visitor reads first,
            and numbered from the top. */}
        {[...events].reverse().map((event, i) => {
          const place = eventSubtitle(event);
          const number = i + 1;
          if (editable) {
            return (
              <li key={event.id}>
                <EditableEventRow event={event} number={number} place={place} renames={renames} />
              </li>
            );
          }
          return (
            <li key={event.id}>
              <GlassCard
                interactive
                role="button"
                tabIndex={0}
                onClick={() => setSelected(event)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelected(event);
                  }
                }}
                className="flex items-center gap-4 px-5 py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="w-6 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                  {String(number).padStart(2, "0")}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium tracking-[-0.01em]">
                    {shownTitle(event, renames)}
                  </span>
                  {place && <span className="block text-xs text-muted-foreground">{place}</span>}
                </span>
                <ChevronLeft className="size-4 shrink-0 rotate-180 text-muted-foreground" />
              </GlassCard>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Admin: one past event, with a pencil to rename it in place. */
function EditableEventRow({
  event,
  number,
  place,
  renames,
}: {
  event: VayamEvent;
  number: number;
  place: string | null;
  renames: EventRenames | undefined;
}) {
  const qc = useQueryClient();
  const title = shownTitle(event, renames);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  const rename = useMutation({
    mutationFn: (next: string) => api.renamePastEvent(event.id, next),
    onSuccess: (next) => {
      qc.setQueryData(["past-events"], next);
      toast.success(`Renamed to "${shownTitle(event, next)}"`);
      setEditing(false);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not rename the event"),
  });

  const trimmed = draft.trim();
  return (
    <GlassCard className="flex items-center gap-4 px-5 py-3">
      <span className="w-6 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
        {String(number).padStart(2, "0")}
      </span>
      {editing ? (
        <form
          className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (trimmed.length >= 2 && trimmed !== title) rename.mutate(trimmed);
            else setEditing(false);
          }}
        >
          <input
            autoFocus
            aria-label="Event name"
            value={draft}
            maxLength={120}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(false);
            }}
            className="h-10 min-w-0 flex-1 rounded-xl border border-hairline bg-background/60 px-3 font-medium outline-none focus:ring-2 focus:ring-ring"
          />
          <GlassButton type="submit" size="sm" icon={<Check className="size-4" />} loading={rename.isPending} disabled={trimmed.length < 2}>
            Save
          </GlassButton>
          <GlassButton type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
            Cancel
          </GlassButton>
        </form>
      ) : (
        <>
          <span className="min-w-0 flex-1 py-1">
            <span className="block truncate font-medium tracking-[-0.01em]">{title}</span>
            {place && <span className="block text-xs text-muted-foreground">{place}</span>}
          </span>
          <button
            type="button"
            aria-label={`Rename ${title}`}
            onClick={() => {
              setDraft(title);
              setEditing(true);
            }}
            className="press flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Pencil className="size-4" />
          </button>
        </>
      )}
    </GlassCard>
  );
}

function EventDetail({
  event,
  renames,
  onBack,
}: {
  event: VayamEvent;
  renames: EventRenames | undefined;
  onBack: () => void;
}) {
  const place = eventSubtitle(event);

  return (
    <section className="mt-14 rise-in">
      <button
        onClick={onBack}
        className="press mb-5 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full"
      >
        <ChevronLeft className="size-4" /> All events
      </button>

      <h2 className="text-3xl font-semibold tracking-[-0.03em]">{shownTitle(event, renames)}</h2>
      {place && <p className="mt-1 text-sm text-muted-foreground">{place}</p>}

      <p className="mt-4 max-w-prose text-sm leading-relaxed text-muted-foreground">
        Contact the team for photos.
      </p>

      <div className="mt-6 space-y-2">
        <ContactRow
          href={contact.whatsappHref}
          external
          icon={<MessageCircle className="size-5" strokeWidth={1.6} />}
          label="WhatsApp"
          value={contact.phoneDisplay}
          hint="Opens a chat"
        />
        <ContactRow
          href={contact.phoneHref}
          icon={<Phone className="size-5" strokeWidth={1.6} />}
          label="Call"
          value={contact.phoneDisplay}
          hint="Opens your dialler"
        />
        <ContactRow
          href={contact.emailHref}
          icon={<Mail className="size-5" strokeWidth={1.6} />}
          label="Email"
          value={contact.email}
          hint="Opens your mail app"
        />
        <ContactRow
          href={contact.websiteHref}
          external
          icon={<Globe className="size-5" strokeWidth={1.6} />}
          label="Website"
          value={contact.websiteDisplay}
          hint="Opens in a new tab"
        />
      </div>
    </section>
  );
}

function ContactRow({
  href,
  external,
  icon,
  label,
  value,
  hint,
}: {
  href: string;
  external?: boolean;
  icon: React.ReactNode;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      aria-label={`${label}: ${value}. ${hint}.`}
      className="block rounded-3xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <GlassCard interactive className="flex items-center gap-4 px-5 py-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs uppercase tracking-[0.1em] text-muted-foreground">
            {label}
          </span>
          <span className="block truncate font-medium tracking-[-0.01em]">{value}</span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{hint}</span>
      </GlassCard>
    </a>
  );
}
