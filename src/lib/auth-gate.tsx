import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useSession } from "./session";

/** Redirects to /auth when there is no signed-in user. Returns the user (or null while loading). */
export function useRequireAuth() {
  const { user, loading } = useSession();
  const navigate = useNavigate();
  useEffect(() => {
    if (!loading && !user) navigate({ to: "/auth", replace: true });
  }, [loading, user, navigate]);
  return { user, loading };
}
