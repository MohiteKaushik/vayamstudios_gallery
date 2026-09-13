import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Aperture } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { useSession } from "@/lib/session";
import { FieldError, GlassButton, GlassCard } from "@/components/ui-kit";
import { normalisePhone, validateSignUp, type FieldErrors } from "@/lib/members";
import { ContactButton } from "@/components/ContactSheet";
import { Logo } from "@/components/Logo";
import { isKnownDevice, rememberDevice } from "@/lib/device";

export const Route = createFileRoute("/auth")({
  // "up" opens on creating an account and "in" on signing in. Left out, the page
  // decides from whether this device has signed in before.
  validateSearch: (s: Record<string, unknown>) => ({
    mode: s["mode"] === "up" ? ("up" as const) : s["mode"] === "in" ? ("in" as const) : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Sign in | VAYAM Designers Gallery" },
      { name: "description", content: "Sign in to VAYAM Designers Gallery to find every photo you appear in." },
      { property: "og:title", content: "Sign in | VAYAM Designers Gallery" },
      { property: "og:description", content: "Sign in to VAYAM Designers Gallery to find every photo you appear in." },
    ],
  }),
  component: AuthPage,
});

/**
 * There is one sign-in form.
 *
 * A second tab labelled "Admin console" used to sit beside it, which announced
 * to every visitor that an operator console exists and showed them its door.
 * It is off the front end now. Nothing about who may do what has changed: the
 * operator signs in on this same form with the same address and password, the
 * server recognises the address as the one in ADMIN_EMAIL, and the console
 * appears for them and for nobody else.
 */

/** Posts to the auth API and returns the error message, or null on success. */
async function post(
  action: "signin" | "signup",
  body: Record<string, string>,
): Promise<{ error: string | null; fields?: FieldErrors; status?: number }> {
  try {
    const res = await fetch(`/api/auth/${action}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return { error: null };
    const payload = (await res.json().catch(() => ({}))) as {
      error?: string;
      errors?: FieldErrors;
      reference?: string;
    };
    // A reference means the server logged a stack for it, so quote it.
    const suffix = payload.reference ? ` (ref ${payload.reference})` : "";
    return {
      error: (payload.error ?? "That did not work") + suffix,
      status: res.status,
      ...(payload.errors ? { fields: payload.errors } : {}),
    };
  } catch {
    return { error: "Could not reach the server. Check your connection." };
  }
}

function AuthPage() {
  const { user, loading, refresh } = useSession();
  const navigate = useNavigate();
  const { mode: asked } = Route.useSearch();

  // Somebody arriving from "Get started" has almost never made an account, and
  // opening on a sign-in form is how people ended up typing a password for an
  // account that did not exist and being told it was wrong. So a new device
  // opens on creating an account and a device that has signed in before opens
  // on signing in. Whatever the link asked for wins over both.
  const [mode, setModeState] = useState<"in" | "up">(asked ?? "up");
  const [noMatch, setNoMatch] = useState(false);

  useEffect(() => {
    if (asked) setModeState(asked);
    else if (isKnownDevice()) setModeState("in");
  }, [asked]);

  const setMode = (next: "in" | "up") => {
    setModeState(next);
    setNoMatch(false);
    navigate({ to: "/auth", search: { mode: next }, replace: true });
  };
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && user) {
      rememberDevice();
      navigate({ to: user.role === "admin" ? "/home" : "/home", replace: true });
    }
  }, [user, loading, navigate]);

  async function submitMember(e: FormEvent) {
    e.preventDefault();

    if (mode === "up") {
      const found = validateSignUp({ fullName, phone, email, password });
      setErrors(found);
      if (Object.keys(found).length > 0) return;
    }

    setBusy(true);
    const result =
      mode === "in"
        ? await post("signin", { email: email.trim(), password })
        : await post("signup", {
            email: email.trim(),
            password,
            fullName: fullName.trim(),
            phone: normalisePhone(phone),
          });
    setBusy(false);

    if (result.error) {
      if (result.fields) setErrors(result.fields);
      // A refused sign-in is far more often "never signed up here" than "typed
      // the password wrong", so it says so and offers the way through, rather
      // than a toast that repeats only the first half.
      if (mode === "in" && result.status === 401) setNoMatch(true);
      else toast.error(result.error);
      return;
    }
    rememberDevice();
    if (mode === "up") toast.success("Account created");
    await refresh();
  }


  const clearError = (field: keyof FieldErrors) =>
    setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));

  const input =
    "h-12 w-full rounded-2xl border border-hairline bg-background/60 px-4 text-[0.95rem] outline-none transition focus:ring-2 focus:ring-ring";

  return (
    <div className="relative flex min-h-dvh items-center justify-center px-5 py-24">
      <div className="ambient-field" aria-hidden />
      <header className="absolute inset-x-0 top-0 mx-auto flex h-20 max-w-6xl items-center justify-between px-5">
        <Link to="/" className="press flex h-10 items-center" aria-label="VAYAM Designers Gallery">
          <Logo className="h-8 sm:h-10" />
        </Link>
        <ContactButton />
      </header>
      <GlassCard className="rise-in w-full max-w-sm p-8">
        <div className="mb-8 flex flex-col items-center text-center">
          <Aperture className="mb-4 size-8" strokeWidth={1.4} />
          <h1 className="text-2xl font-semibold tracking-[-0.03em]">
            {mode === "in" ? "Welcome back" : "Create your account"}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Your photos are matched to you and shared with nobody else.
          </p>
        </div>
        <form onSubmit={submitMember} className="space-y-3" noValidate>
          {mode === "up" && (
            <>
              <div>
                <input
                  className={input}
                  type="text"
                  placeholder="Full name"
                  autoComplete="name"
                  value={fullName}
                  aria-invalid={!!errors.fullName}
                  onChange={(e) => {
                    setFullName(e.target.value);
                    clearError("fullName");
                  }}
                />
                <FieldError message={errors.fullName} />
              </div>
              <div>
                <input
                  className={input}
                  type="tel"
                  inputMode="numeric"
                  placeholder="Mobile number"
                  autoComplete="tel"
                  value={phone}
                  aria-invalid={!!errors.phone}
                  onChange={(e) => {
                    setPhone(e.target.value);
                    clearError("phone");
                  }}
                />
                <FieldError message={errors.phone} />
              </div>
            </>
          )}
          <div>
            <input
              className={input}
              type="email"
              placeholder="Email"
              autoComplete="email"
              required
              value={email}
              aria-invalid={!!errors.email}
              onChange={(e) => {
                setEmail(e.target.value);
                clearError("email");
                setNoMatch(false);
              }}
            />
            <FieldError message={errors.email} />
          </div>
          <div>
            <input
              className={input}
              type="password"
              placeholder="Password"
              autoComplete={mode === "in" ? "current-password" : "new-password"}
              required
              value={password}
              aria-invalid={!!errors.password}
              onChange={(e) => {
                setPassword(e.target.value);
                clearError("password");
                setNoMatch(false);
              }}
            />
            <FieldError message={errors.password} />
          </div>
          <GlassButton type="submit" full size="lg" loading={busy} className="mt-2">
            {mode === "in" ? "Sign in" : "Create account"}
          </GlassButton>
        </form>

        {noMatch && mode === "in" && (
          <div
            role="alert"
            className="mt-5 rounded-2xl border border-hairline bg-secondary/60 px-4 py-3 text-sm leading-relaxed"
          >
            <p className="font-medium">That email and password do not match an account.</p>
            <p className="mt-1 text-muted-foreground">
              If this is your first time here, create an account first. It takes a minute.
            </p>
            <button
              type="button"
              onClick={() => setMode("up")}
              className="mt-3 rounded-full font-semibold text-foreground underline decoration-2 underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Create an account
            </button>
          </div>
        )}

        <p className="mt-6 text-center text-sm text-muted-foreground">
          {mode === "in" ? "New here? " : "Already have an account? "}
          <button
            type="button"
            onClick={() => {
              setMode(mode === "in" ? "up" : "in");
              setErrors({});
            }}
            className="rounded-full font-semibold text-foreground underline decoration-2 underline-offset-4 transition hover:decoration-foreground/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {mode === "in" ? "Create an account" : "Sign in"}
          </button>
        </p>
      </GlassCard>
    </div>
  );
}
