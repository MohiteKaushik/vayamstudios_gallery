import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { isAdminSession } from "@/lib/admin.functions";

/**
 * True when the signed-in user is the operator.
 *
 * Decided on the server, from the email inside the caller's verified token, so
 * it does not depend on a row existing in user_roles. That row often cannot be
 * written by the account itself under normal access rules, which used to leave
 * the operator locked out of their own console until someone edited the
 * database by hand.
 *
 * This only drives what the interface offers. Anything that actually matters is
 * checked again on the server at the point of use.
 */
export function useIsAdmin(userId: string | undefined) {
  const check = useServerFn(isAdminSession);
  return useQuery({
    queryKey: ["is-admin", userId],
    enabled: !!userId,
    staleTime: 5 * 60 * 1000,
    retry: false,
    queryFn: async () => {
      try {
        return await check();
      } catch {
        // An unauthenticated or expired session is simply not an admin.
        return false;
      }
    },
  });
}
