import { createFileRoute, Navigate } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { EmptyState } from "@/components/ui-kit";
import { useRequireAuth } from "@/lib/auth-gate";
import { useIsAdmin } from "@/lib/roles";

/**
 * The admin console.
 *
 * Managing collections and managing photos are the same screens whether an
 * operator or a member is looking at them; only what they may do differs, and
 * the collections screen already decides that from the signed-in role. This
 * route used to hold a second, near-identical copy of all of it, which is how
 * the two drifted apart and why a fix in one place did not show up in the
 * other. It now checks the role and sends operators to the one implementation.
 */
export const Route = createFileRoute("/admin")({
  validateSearch: (s: Record<string, unknown>) => ({
    id: typeof s["id"] === "string" ? s["id"] : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Admin — VAYAM Designers Gallery" },
      { name: "description", content: "Publish photo collections that members can scan for themselves." },
      { property: "og:title", content: "Admin — VAYAM Designers Gallery" },
      { property: "og:description", content: "Publish photo collections that members can scan for themselves." },
    ],
  }),
  component: AdminPage,
});

function AdminPage() {
  const { user } = useRequireAuth();
  const { id } = Route.useSearch();
  const isAdmin = useIsAdmin(user?.id);

  if (!user || isAdmin.isLoading) return null;

  if (!isAdmin.data) {
    return (
      <AppShell>
        <EmptyState
          icon={<ShieldCheck className="size-7" strokeWidth={1.5} />}
          title="Admins only"
          description="This area is for publishing shared collections. Ask an administrator to grant you access."
        />
      </AppShell>
    );
  }

  // Carries the collection through, so an /admin?id=… link keeps working.
  return <Navigate to="/collections" search={{ shared: id }} replace />;
}
