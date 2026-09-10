import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

/**
 * Who is signed in.
 *
 * The session lives in an HttpOnly cookie, so page scripts cannot read it and
 * this asks the server instead. That is deliberate: a token JavaScript can read
 * is a token an injected script can steal.
 *
 * There is exactly one identity system now. The previous arrangement had two,
 * an outside service and this Worker, and every confusing permission error came
 * from them disagreeing about who someone was.
 */

export type Member = {
  id: string;
  email: string;
  fullName: string;
  phone: string;
  role: "admin" | "member";
  onboarded: boolean;
  createdAt: number;
  lastSignInAt: number | null;
};

type Ctx = {
  user: Member | null;
  loading: boolean;
  /** Re-reads the session, after signing in or out. */
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
};

const SessionContext = createContext<Ctx>({
  user: null,
  loading: true,
  refresh: async () => {},
  signOut: async () => {},
});

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Member | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/me", { credentials: "same-origin" });
      // A 401 is the normal signed-out answer, not a failure.
      setUser(res.ok ? ((await res.json()) as Member) : null);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    await fetch("/api/auth/signout", { method: "POST", credentials: "same-origin" }).catch(
      () => undefined,
    );
    setUser(null);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <SessionContext.Provider value={{ user, loading, refresh, signOut }}>
      {children}
    </SessionContext.Provider>
  );
}

export const useSession = () => useContext(SessionContext);
