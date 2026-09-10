import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Aperture, ShieldCheck } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { useSession } from "@/lib/session";
import { FieldError, GlassButton, GlassCard } from "@/components/ui-kit";
import { normalisePhone, validateSignUp, type FieldErrors } from "@/lib/members";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in — VAYAM Designers Gallery" },
      { name: "description", content: "Sign in to VAYAM Designers Gallery to find every photo you appear in." },
      { property: "og:title", content: "Sign in — VAYAM Designers Gallery" },
      { property: "og:description", content: "Sign in to VAYAM Designers Gallery to find every photo you appear in." },
    ],
  }),
  component: AuthPage,
});

type Panel = "member" | "admin";

/** Posts to the auth API and returns the error message, or null on success. */
async function post(
  action: "signin" | "signup",
  body: Record<string, string>,
): Promise<{ error: string | null; fields?: FieldErrors }> {
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
      ...(payload.errors ? { fields: payload.errors } : {}),
    };
  } catch {
    return { error: "Could not reach the server. Check your connection." };
  }
}

function AuthPage() {
  const { user, loading, refresh } = useSession();
  const navigate = useNavigate();
  const [panel, setPanel] = useState<Panel>("member");
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [adminId, setAdminId] = useState("");
  const [adminPass, setAdminPass] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && user) {
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
      toast.error(result.error);
      return;
    }
    if (mode === "up") toast.success("Account created");
    await refresh();
  }

  async function submitAdmin(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const result = await post("signin", { email: adminId.trim(), password: adminPass });
    setBusy(false);

    if (result.error) {
      toast.error("Those operator credentials aren't right");
      return;
    }
    toast.success("Welcome to the admin console");
    await refresh();
  }

  const clearError = (field: keyof FieldErrors) =>
    setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));

  const input =
    "h-12 w-full rounded-2xl border border-hairline bg-background/60 px-4 text-[0.95rem] outline-none transition focus:ring-2 focus:ring-ring";
  const tab = (active: boolean) =>
    `flex-1 rounded-xl px-3 py-2 text-[0.82rem] font-medium transition ${
      active ? "bg-background/80 text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
    }`;

  return (
    <div className="relative flex min-h-dvh items-center justify-center px-5">
      <div className="ambient-field" aria-hidden />
      <GlassCard className="rise-in w-full max-w-sm p-8">
        <div className="mb-6 flex gap-1 rounded-2xl border border-hairline bg-background/40 p-1">
          <button type="button" className={tab(panel === "member")} onClick={() => setPanel("member")}>
            Member
          </button>
          <button type="button" className={tab(panel === "admin")} onClick={() => setPanel("admin")}>
            Admin console
          </button>
        </div>

        {panel === "member" ? (
          <>
            <div className="mb-8 flex flex-col items-center text-center">
              <Aperture className="mb-4 size-8" strokeWidth={1.4} />
              <h1 className="text-2xl font-semibold tracking-[-0.03em]">
                {mode === "in" ? "Welcome back" : "Create your account"}
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">Your face data never leaves your device.</p>
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
                  }}
                />
                <FieldError message={errors.password} />
              </div>
              <GlassButton type="submit" full size="lg" loading={busy} className="mt-2">
                {mode === "in" ? "Sign in" : "Create account"}
              </GlassButton>
            </form>
            <button
              type="button"
              onClick={() => {
                setMode(mode === "in" ? "up" : "in");
                setErrors({});
              }}
              className="mt-6 w-full rounded-full text-center text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {mode === "in" ? "New here? Create an account" : "Already have an account? Sign in"}
            </button>
          </>
        ) : (
          <>
            <div className="mb-8 flex flex-col items-center text-center">
              <ShieldCheck className="mb-4 size-8" strokeWidth={1.4} />
              <h1 className="text-2xl font-semibold tracking-[-0.03em]">Admin console</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                For the team that uploads and manages shared collections.
              </p>
            </div>
            <form onSubmit={submitAdmin} className="space-y-3">
              <input
                className={input}
                type="email"
                placeholder="Admin email"
                autoComplete="username"
                required
                value={adminId}
                onChange={(e) => setAdminId(e.target.value)}
              />
              <input
                className={input}
                type="password"
                placeholder="Password"
                autoComplete="current-password"
                required
                value={adminPass}
                onChange={(e) => setAdminPass(e.target.value)}
              />
              <GlassButton type="submit" full size="lg" loading={busy} className="mt-2">
                Enter console
              </GlassButton>
            </form>
          </>
        )}
      </GlassCard>
    </div>
  );
}
