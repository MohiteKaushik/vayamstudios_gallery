import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpRight, Cpu, Lock, PenTool, Rocket, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { ContactButton } from "@/components/ContactSheet";
import { Logo } from "@/components/Logo";
import { isKnownDevice, rememberDevice } from "@/lib/device";
import { GlassButton, GlassCard } from "@/components/ui-kit";
import { useSession } from "@/lib/session";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "VAYAM Designers Gallery | Find every photo you're in" },
      {
        name: "description",
        content:
          "Find every photo you appear in with private, on-device face matching. Built by VAYAM Designers, India's leading design, branding and development studio.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { property: "og:title", content: "VAYAM Designers Gallery | Find every photo you're in" },
      {
        property: "og:description",
        content:
          "Private, on-device face matching that surfaces only the photos you're in. By VAYAM Designers.",
      },
    ],
  }),
  component: Landing,
});

const points = [
  { icon: Lock, title: "Private by design", body: "Your photos are analysed on your device and never sent to a third party." },
  { icon: Cpu, title: "Instant results", body: "Your photos from the whole event come back in seconds, not minutes." },
  { icon: Sparkles, title: "Precision matching", body: "A 512-point face signature tells you apart from everyone else in the frame, even at an angle." },
];

const services = [
  { icon: PenTool, title: "Design", body: "Brand identity, packaging and interfaces crafted to the last pixel." },
  { icon: Sparkles, title: "Branding", body: "Strategy, naming and story that make a brand impossible to ignore." },
  { icon: Rocket, title: "Development", body: "Fast, reliable web and product engineering, shipped end to end." },
];

function Landing() {
  const { user } = useSession();
  // Decided once the page has loaded, because only the browser knows whether
  // this device has signed in before. Guessing on the server would render one
  // destination and then swap it for another.
  const [known, setKnown] = useState(false);
  useEffect(() => {
    if (user) rememberDevice();
    setKnown(isKnownDevice());
  }, [user]);
  const startMode = known ? ("in" as const) : ("up" as const);

  return (
    <div className="relative min-h-dvh">
      <div className="ambient-field" aria-hidden />
      <header className="mx-auto flex h-20 max-w-6xl items-center justify-between px-5">
        <Link to="/" className="press flex h-8 items-center" aria-label="VAYAM Designers Gallery">
          <Logo className="h-8 sm:h-10" />
        </Link>
        <div className="flex shrink-0 items-center gap-2">
          <ContactButton />
          {user ? (
            <Link to="/home">
              <GlassButton variant="glass" size="sm">
                Open app
              </GlassButton>
            </Link>
          ) : (
            <Link to="/auth" search={{ mode: "in" }}>
              <GlassButton variant="glass" size="sm">
                Sign in
              </GlassButton>
            </Link>
          )}
        </div>
      </header>

      <section className="mx-auto max-w-3xl px-5 pt-20 text-center sm:pt-32">
        <p className="rise-in mb-6 inline-flex items-center gap-2 rounded-full bg-secondary px-4 py-1.5 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
          An initiative by VAYAM Designers
        </p>
        <h1 className="rise-in text-balance text-5xl font-semibold leading-[1.02] tracking-[-0.045em] sm:text-7xl">
          Your photos,
          <br />
          found for you.
        </h1>
        <p className="rise-in mx-auto mt-7 max-w-xl text-lg leading-relaxed text-muted-foreground [animation-delay:80ms]">
          Add one reference photo and we quietly pick out every frame you appear in.
        </p>
        <div className="rise-in mt-10 flex justify-center [animation-delay:160ms]">
          {user ? (
            <Link to="/home">
              <GlassButton size="lg">Get started</GlassButton>
            </Link>
          ) : (
            // A first visit opens on creating an account. Opening on sign-in
            // is how new guests ended up told their password was wrong for an
            // account they had never made.
            <Link to="/auth" search={{ mode: startMode }}>
              <GlassButton size="lg">Get started</GlassButton>
            </Link>
          )}
        </div>
      </section>

      <section className="mx-auto grid max-w-5xl gap-4 px-5 pt-28 sm:grid-cols-3">
        {points.map((p) => (
          <GlassCard key={p.title} className="p-7">
            <p.icon className="mb-5 size-6 text-muted-foreground" strokeWidth={1.5} />
            <h2 className="text-lg font-semibold tracking-[-0.02em]">{p.title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{p.body}</p>
          </GlassCard>
        ))}
      </section>

      <section className="mx-auto max-w-5xl px-5 pb-28 pt-24">
        <GlassCard className="overflow-hidden p-8 sm:p-12">
          <div className="flex flex-col gap-10 lg:flex-row lg:items-center lg:justify-between">
            <div className="max-w-xl">
              <Logo className="h-12" />
              <h2 className="mt-7 text-balance text-3xl font-semibold leading-tight tracking-[-0.035em] sm:text-4xl">
                India's finest design, branding and development company.
              </h2>
              <p className="mt-4 text-base leading-relaxed text-muted-foreground">
                This gallery is built by VAYAM Designers, a studio trusted for brand identities, campaigns
                and digital products that look considered and perform even better. If you like how this feels,
                imagine what we could build for you.
              </p>
              <a
                href="https://vayamdesigners.com"
                target="_blank"
                rel="noreferrer"
                className="mt-8 inline-flex"
              >
                <GlassButton size="lg" icon={<ArrowUpRight className="size-4" />}>
                  Work with VAYAM Designers
                </GlassButton>
              </a>
            </div>
            <ul className="grid gap-3 sm:grid-cols-3 lg:w-[22rem] lg:grid-cols-1">
              {services.map((s) => (
                <li
                  key={s.title}
                  className="rounded-2xl bg-secondary/60 p-5 transition-colors hover:bg-secondary"
                >
                  <s.icon className="mb-3 size-5 text-muted-foreground" strokeWidth={1.5} />
                  <p className="font-medium tracking-[-0.01em]">{s.title}</p>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </GlassCard>
      </section>

      <footer className="mx-auto flex max-w-5xl flex-col items-center gap-3 px-5 pb-14 text-center">
        <Logo className="h-8 opacity-60" />
        <p className="text-xs text-muted-foreground">
          © {new Date().getFullYear()} VAYAM Designers. Photos and faces stay private to you.
        </p>
      </footer>
    </div>
  );
}
