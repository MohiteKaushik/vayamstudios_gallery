import { Clock, Globe, Mail, MapPin, MessageCircle, Phone, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { GlassButton } from "@/components/ui-kit";
import { cn } from "@/lib/utils";
import { office } from "@/lib/vayam";

/**
 * "Contact us", in the top right corner of every page.
 *
 * Details only. A message form sat here briefly, but nothing delivered its
 * messages to an inbox, and a form that sends into nothing is worse than no
 * form. Every way of reaching the studio below opens straight into an app a
 * visitor already uses: phone, WhatsApp, email.
 *
 * The panel is rendered into document.body rather than where the button sits.
 * The app header is frosted glass, and a backdrop filter makes its box the
 * containing block for anything fixed inside it, so a dialog left in place
 * would be squeezed into the header instead of covering the page.
 */
export function ContactButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <GlassButton
        variant="glass"
        size="sm"
        className={cn("shrink-0", className)}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        Contact us
      </GlassButton>
      {open && createPortal(<ContactSheet onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function ContactSheet({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/55 backdrop-blur-sm sm:items-center sm:p-5"
      onClick={onClose}
    >
      <div
        className="glass-surface rise-in relative max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-t-3xl p-6 sm:rounded-3xl sm:p-10"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="press absolute right-4 top-4 flex size-9 items-center justify-center rounded-full bg-secondary text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" />
        </button>

        <h2 id={titleId} className="text-2xl font-semibold tracking-[-0.03em] sm:text-3xl">
          Visit us
        </h2>
        <ul className="mt-7 space-y-4 text-[0.95rem]">
          <Detail icon={<MapPin strokeWidth={1.6} />} href={office.mapsHref} external>
            {office.address}
          </Detail>
          <Detail icon={<Clock strokeWidth={1.6} />}>{office.hours}</Detail>
          <Detail icon={<Phone strokeWidth={1.6} />} href={office.phoneHref}>
            {office.phoneDisplay}
          </Detail>
          <Detail icon={<MessageCircle strokeWidth={1.6} />} href={office.whatsappHref} external>
            Chat with us on WhatsApp
          </Detail>
          <Detail icon={<Mail strokeWidth={1.6} />} href={office.emailHref}>
            {office.email}
          </Detail>
          <Detail icon={<Globe strokeWidth={1.6} />} href={office.websiteHref} external>
            {office.websiteDisplay}
          </Detail>
        </ul>
      </div>
    </div>
  );
}

function Detail({
  icon,
  href,
  external,
  children,
}: {
  icon: ReactNode;
  href?: string;
  external?: boolean;
  children: ReactNode;
}) {
  const body = (
    <>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground [&>svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0 pt-1.5 leading-relaxed">{children}</span>
    </>
  );
  return (
    <li>
      {href ? (
        <a
          href={href}
          {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          className="flex items-start gap-3 rounded-2xl text-foreground/90 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {body}
        </a>
      ) : (
        <div className="flex items-start gap-3 text-foreground/90">{body}</div>
      )}
    </li>
  );
}
