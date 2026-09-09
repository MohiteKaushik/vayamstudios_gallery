import { ChevronLeft, Globe, Mail, MessageCircle, Phone } from "lucide-react";
import { useEffect, useState } from "react";
import { GlassCard } from "@/components/ui-kit";
import { contact, events, eventSubtitle, eventTitle, type VayamEvent } from "@/lib/vayam";

/**
 * The studio's past work, shown to a member once their face profile is set up.
 *
 * Choosing an event does not open photos. It opens a way to reach the team,
 * which is the point: a member browsing this is a prospective client looking at
 * what VAYAM has run, and the next step is a conversation.
 */
export function EventShowcase() {
  const [selected, setSelected] = useState<VayamEvent | null>(null);

  // Escape closes the panel, matching every other layer in the app.
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  if (selected) return <EventDetail event={selected} onBack={() => setSelected(null)} />;

  return (
    <section className="mt-14">
      <h2 className="mb-1 text-sm font-medium uppercase tracking-[0.12em] text-muted-foreground">
        Events we have run
      </h2>
      <p className="mb-5 text-sm text-muted-foreground">
        Select any of these to talk to the team about your own.
      </p>

      <ul className="space-y-2">
        {events.map((event, i) => {
          const place = eventSubtitle(event);
          return (
            <li key={`${event.name}-${event.year ?? ""}-${place ?? ""}`}>
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
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium tracking-[-0.01em]">
                    {eventTitle(event)}
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

function EventDetail({ event, onBack }: { event: VayamEvent; onBack: () => void }) {
  const place = eventSubtitle(event);

  return (
    <section className="mt-14 rise-in">
      <button
        onClick={onBack}
        className="press mb-5 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full"
      >
        <ChevronLeft className="size-4" /> All events
      </button>

      <h2 className="text-3xl font-semibold tracking-[-0.03em]">{eventTitle(event)}</h2>
      {place && <p className="mt-1 text-sm text-muted-foreground">{place}</p>}

      <p className="mt-4 max-w-prose text-sm leading-relaxed text-muted-foreground">
        Run end to end by VAYAM Designers. If you are planning something similar, the
        team can talk you through how this one came together.
      </p>

      <h3 className="mb-3 mt-9 text-sm font-medium uppercase tracking-[0.12em] text-muted-foreground">
        Contact the team
      </h3>

      <div className="space-y-2">
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
