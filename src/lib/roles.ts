import { useSession } from "./session";

/**
 * True when the signed-in person is the operator.
 *
 * The role travels with the session, decided on the server from the member's
 * own record. There is no second lookup and no second identity system to
 * disagree with it, which is what previously produced an account that could
 * create a collection but not upload into it.
 *
 * This only drives what the interface offers. Every action that matters is
 * checked again on the server at the point of use.
 */
export function useIsAdmin(_userId?: string | undefined) {
  const { user, loading } = useSession();
  return {
    data: user?.role === "admin",
    isLoading: loading,
  };
}
