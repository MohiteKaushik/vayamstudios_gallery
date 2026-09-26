import { createFileRoute } from "@tanstack/react-router";
import { CollectionsPage } from "./collections";

export const Route = createFileRoute("/live-events")({
  validateSearch: (s: Record<string, unknown>): { shared: string | undefined; event?: string } => ({
    shared: typeof s["shared"] === "string" ? s["shared"] : undefined,
    ...(typeof s["event"] === "string" ? { event: s["event"] } : {}),
  }),
  head: () => ({
    meta: [
      { title: "Live Events | VAYAM Designers Gallery" },
      { name: "description", content: "Browse photographs from our live events." },
    ],
  }),
  component: () => <CollectionsPage live />,
});
