import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export function useLiveEventsAvailable() {
  const events = useQuery({
    queryKey: ["showcase-events"],
    queryFn: api.showcaseEvents,
    select: (items) => items.some((event) => event.live && !event.hidden),
    staleTime: 30_000,
    retry: false,
  });
  return events.data === true;
}
