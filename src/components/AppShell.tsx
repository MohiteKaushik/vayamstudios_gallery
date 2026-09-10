import { Link, useNavigate } from "@tanstack/react-router";
import { House, Images, Layers, Settings2 } from "lucide-react";
import type { ReactNode } from "react";
import { Logo } from "@/components/Logo";
import { cn } from "@/lib/utils";

const nav = [
  { to: "/home", label: "Home", icon: House },
  { to: "/photos", label: "Photos", icon: Images },
  { to: "/collections", label: "Live Event", icon: Layers },
  { to: "/settings", label: "Settings", icon: Settings2 },
] as const;

export function AppShell({ children, wide }: { children: ReactNode; wide?: boolean }) {
  const navigate = useNavigate();

  return (
    <div className="relative min-h-dvh">
      <div className="ambient-field" aria-hidden />

      <header className="glass-chrome sticky top-0 z-40 hairline-b">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
          <button
            onClick={() => navigate({ to: "/home" })}
            className="press flex h-6 items-center"
            aria-label="VAYAM Designers Gallery home"
          >
            <Logo className="h-6" />
          </button>


          <nav className="hidden items-center gap-1 sm:flex" aria-label="Primary">
            {nav.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className="press rounded-full px-4 py-2 text-[0.85rem] text-muted-foreground hover:bg-secondary hover:text-foreground data-[status=active]:bg-secondary data-[status=active]:text-foreground"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      <main
        className={cn(
          "mx-auto w-full px-5 pb-32 pt-8 sm:pb-16",
          wide ? "max-w-6xl" : "max-w-3xl",
        )}
      >
        {children}
      </main>

      <nav
        aria-label="Primary"
        className="glass-chrome safe-bottom fixed inset-x-0 bottom-0 z-40 border-t sm:hidden"
      >
        <div className="mx-auto flex max-w-md items-stretch justify-between px-3 pt-2">
          {nav.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                className="press flex flex-1 flex-col items-center gap-1 rounded-2xl py-2 text-[0.68rem] text-muted-foreground data-[status=active]:text-foreground"
              >
                <Icon className="size-5" strokeWidth={1.6} />
                {item.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
