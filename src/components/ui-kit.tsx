import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/* ---------------------------------- Button --------------------------------- */

type Variant = "primary" | "glass" | "ghost" | "quiet" | "danger";
type Size = "sm" | "md" | "lg";

const variants: Record<Variant, string> = {
  primary:
    "bg-primary text-primary-foreground hover:bg-primary/90 shadow-[var(--shadow-soft)] disabled:opacity-40",
  glass:
    "glass-surface text-foreground hover:bg-glass-strong disabled:opacity-40 rounded-full",
  ghost: "text-foreground hover:bg-secondary disabled:opacity-40",
  quiet: "bg-secondary text-secondary-foreground hover:bg-muted disabled:opacity-40",
  danger: "bg-destructive/10 text-destructive hover:bg-destructive/16 disabled:opacity-40",
};

const sizes: Record<Size, string> = {
  sm: "h-9 px-4 text-[0.82rem]",
  md: "h-11 px-5 text-[0.9rem]",
  lg: "h-14 px-7 text-[0.98rem]",
};

export interface GlassButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
  full?: boolean;
}

export const GlassButton = forwardRef<HTMLButtonElement, GlassButtonProps>(function GlassButton(
  { className, variant = "primary", size = "md", loading, icon, full, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "press inline-flex select-none items-center justify-center gap-2 rounded-full font-medium tracking-[-0.01em]",
        "disabled:pointer-events-none",
        variants[variant],
        sizes[size],
        full && "w-full",
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

/* -------------------------------- FieldError -------------------------------- */

/** Inline form error. Renders nothing when valid, so the form does not jump. */
export function FieldError({ message }: { message?: string | undefined }) {
  if (!message) return null;
  return <p className="mt-1.5 px-4 text-xs text-destructive">{message}</p>;
}

/* ----------------------------------- Card ---------------------------------- */

export function GlassCard({
  className,
  interactive,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) {
  return (
    <div
      className={cn(
        "glass-surface rounded-3xl",
        interactive &&
          "press cursor-pointer hover:shadow-[var(--shadow-lifted)] hover:-translate-y-0.5",
        className,
      )}
      {...rest}
    />
  );
}

/* -------------------------------- EmptyState -------------------------------- */

export function EmptyState({
  icon,
  title,
  description,
  action,
  tone = "neutral",
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  tone?: "neutral" | "error";
}) {
  return (
    <div className="rise-in mx-auto flex max-w-md flex-col items-center px-6 py-16 text-center">
      {icon && (
        <div
          className={cn(
            "mb-6 flex size-14 items-center justify-center rounded-2xl",
            tone === "error" ? "bg-destructive/10 text-destructive" : "bg-secondary text-muted-foreground",
          )}
        >
          {icon}
        </div>
      )}
      <h3 className="text-xl font-semibold">{title}</h3>
      {description && (
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-7">{action}</div>}
    </div>
  );
}

/* -------------------------------- Skeleton ---------------------------------- */

export function Shimmer({ className }: { className?: string }) {
  return <div className={cn("shimmer rounded-2xl bg-secondary", className)} />;
}
