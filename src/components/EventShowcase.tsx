import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronLeft, Globe, Mail, MessageCircle, Pencil, Phone, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { GlassButton, GlassCard, useConfirm } from "@/components/ui-kit";
import { confirmEventDeletion } from "@/lib/confirm-event-deletion";
import { api } from "@/lib/api";
import { contact, eventSubtitle, shownTitle, type EventRenames, type VayamEvent, type ShowcaseEvent } from "@/lib/vayam";
import { Switch } from "./ui/switch";
import { EventShareButton } from "./EventShareButton";

/**
 * The studio's past work, shown to a member once their face profile is set up.
 *
 * Recent selections open the gallery; other events keep their contact panel.
 */
export function EventShowcase({ editable = false }: { editable?: boolean }) {
  const [selected, setSelected] = useState<VayamEvent | null>(null);
  const showcase = useQuery({ queryKey: ["showcase-events"], retry: false, queryFn: api.showcaseEvents });
  const renames = undefined;

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
          ? "Members see this list on their home page."
          : "Select any of these to talk to the team about your own."}
      </p>
      {editable && <NewShowcaseEvent />}
      {showcase.isLoading && <p role="status" className="text-sm text-muted-foreground">Loading events...</p>}
      {showcase.isError && <p role="alert" className="text-sm text-destructive">Could not load events. <button className="underline" onClick={() => void showcase.refetch()}>Retry</button></p>}

      <ul className="space-y-2">
        {(showcase.data ?? []).map((event, i) => {
          const place = eventSubtitle(event);
          const number = i + 1;
          if (editable) {
            return (
              <li key={event.id}>
                <EditableEventRow event={event} number={number} place={place} renames={renames} />
              </li>
            );
          }
          if (event.recent || event.collectionIds.length > 0) {
            return (
              <li key={event.id}>
                <Link
                  to="/collections"
                  search={{ shared: undefined, event: event.id }}
                  aria-label={`Open ${shownTitle(event, renames)} photos`}
                >
                  <EventRow event={event} number={number} place={place} renames={renames} />
                </Link>
              </li>
            );
          }
          return (
            <li key={event.id}>
              <EventRow
                event={event}
                number={number}
                place={place}
                renames={renames}
                onOpen={() => setSelected(event)}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function EventRow({
  event,
  number,
  place,
  renames,
  onOpen,
}: {
  event: VayamEvent;
  number: number;
  place: string | null;
  renames: EventRenames | undefined;
  onOpen?: () => void;
}) {
  return (
    <GlassCard
      interactive
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen}
      onKeyDown={
        onOpen
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen();
              }
            }
          : undefined
      }
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
  );
}

/** Admin: one past event, with a pencil to rename it in place. */
function EditableEventRow({
  event,
  number,
  place,
  renames,
}: {
  event: ShowcaseEvent;
  number: number;
  place: string | null;
  renames: EventRenames | undefined;
}) {
  const qc = useQueryClient();
  const title = shownTitle(event, renames);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const { ask, dialog } = useConfirm();
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.deleteShowcaseEvent(event.id),
    onSuccess: () => {
      for (const key of ["showcase-events", "collections", "recent-collections", "export-collections", "bin", "photos"]) {
        void qc.invalidateQueries({ queryKey: [key] });
      }
      toast.success("Event and photos moved to the recycle bin for 30 days");
    },
    onError: (e) => {
      for (const key of ["showcase-events", "collections", "recent-collections", "bin"]) void qc.invalidateQueries({ queryKey: [key] });
      toast.error(e instanceof Error ? e.message : "Could not delete event");
    },
  });

  const rename = useMutation({
    mutationFn: (next: string) => api.renamePastEvent(event.id, next),
    onSuccess: (next) => {
      qc.setQueryData(["past-events"], next);
      void qc.invalidateQueries({ queryKey: ["showcase-events"] });
      void qc.invalidateQueries({ queryKey: ["collections"] });
      void qc.invalidateQueries({ queryKey: ["recent-collections"] });
      toast.success("Event renamed");
      setEditing(false);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not rename the event"),
  });

  const visibility = useMutation({
    mutationFn: (recent: boolean) => api.setRecentEvent(event.id, recent),
    onSuccess: (events) => {
      qc.setQueryData(["showcase-events"], events);
      void qc.invalidateQueries({ queryKey: ["collections"] });
      void qc.invalidateQueries({ queryKey: ["recent-collections"] });
      void qc.invalidateQueries({ queryKey: ["export-collections"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not update event"),
  });

  const trimmed = draft.trim();
  const hidden = useMutation({
    mutationFn: (value: boolean) => api.setEventHidden(event.id, value),
    onSuccess: (events) => {
      qc.setQueryData(["showcase-events"], events);
      for (const key of ["collections", "recent-collections", "home-cover", "export-collections"]) void qc.invalidateQueries({ queryKey: [key] });
      toast.success(event.hidden ? "Event is visible again" : "Event hidden from members. Photos are kept.");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not change event visibility"),
  });
  const busy = confirming || remove.isPending || rename.isPending || visibility.isPending || hidden.isPending;
  return (
    <>
    {dialog}
    <GlassCard className="flex flex-wrap items-center gap-4 px-5 py-3">
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
            {event.hidden && <span className="text-xs text-muted-foreground">Hidden from members</span>}
            {place && <span className="block text-xs text-muted-foreground">{place}</span>}
          </span>
          <button
            type="button"
            aria-label={`Rename ${title}`}
            disabled={busy}
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
      {!editing && <button type="button" title="Delete event" aria-label={`Delete ${title}`}
        disabled={busy}
        onClick={async () => {
          setConfirming(true);
          try {
            if (await confirmEventDeletion(ask, title)) remove.mutate();
          } finally { setConfirming(false); }
        }}
        className="press flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40">
        <Trash2 className="size-4" />
      </button>}
      <div className="flex w-full flex-wrap items-center justify-between gap-3 border-t border-hairline pt-3">
        <EventShareButton eventId={event.id} name={title} disabled={busy || !!event.hidden} />
        <label className="flex items-center gap-3 text-sm">
          <Switch checked={!!event.hidden} disabled={busy} onCheckedChange={(checked) => hidden.mutate(checked)}
            aria-label={`Hide ${title} from members`} />
          Hide event
        </label>
        <label className="flex items-center gap-3 text-sm">
          <Switch checked={event.recent} disabled={busy} onCheckedChange={(checked) => visibility.mutate(checked)}
            aria-label={`Show ${title} in recent events`} />
          Show in recent events
        </label>
        {event.collectionIds.length > 0 && <Link to="/collections" search={{ shared: undefined, event: event.id }}
          className="text-sm underline">Manage photos</Link>}
      </div>
    </GlassCard>
    </>
  );
}

function NewShowcaseEvent() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [recent, setRecent] = useState(true);
  const create = useMutation({
    mutationFn: () => api.createCollection(name.trim(), undefined, recent),
    onSuccess: () => {
      setName("");
      void qc.invalidateQueries({ queryKey: ["showcase-events"] });
      void qc.invalidateQueries({ queryKey: ["collections"] });
      void qc.invalidateQueries({ queryKey: ["recent-collections"] });
      void qc.invalidateQueries({ queryKey: ["export-collections"] });
      toast.success("Event added");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not add event"),
  });
  return <form className="mb-6 flex flex-wrap items-center gap-3" onSubmit={(e) => { e.preventDefault(); if (name.trim().length >= 2) create.mutate(); }}>
    <input aria-label="New event name" placeholder="New event name" value={name} maxLength={120} required minLength={2}
      disabled={create.isPending} onChange={(e) => setName(e.target.value)}
      className="h-11 w-full min-w-0 rounded-lg border border-hairline bg-secondary px-4 text-sm sm:flex-1" />
    <label className="flex items-center gap-2 text-sm"><Switch checked={recent} disabled={create.isPending} onCheckedChange={setRecent} />Show in recent events</label>
    <GlassButton type="submit" size="sm" icon={<Plus className="size-4" />} loading={create.isPending} disabled={name.trim().length < 2}>Add event</GlassButton>
  </form>;
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
