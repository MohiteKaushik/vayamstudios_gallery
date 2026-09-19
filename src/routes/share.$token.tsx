import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ScanFace, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { GlassButton } from "@/components/ui-kit";
import { PagedPhotoGrid } from "@/components/PagedPhotoGrid";
import { PhotoViewer, type ViewerPhoto } from "@/components/PhotoViewer";
import type { GridPhoto } from "@/components/PhotoGrid";
import { stablePhotoPages } from "@/lib/photo-pages";
import { useSession } from "@/lib/session";
import { downloadPhoto } from "@/lib/download";
import { SHARE_RETURN_KEY } from "@/lib/share-return";

export const Route = createFileRoute("/share/$token")({
  validateSearch: (search: Record<string, unknown>) => ({ album: typeof search["album"] === "string" ? search["album"] : undefined }),
  head: () => ({ meta: [{ name: "robots", content: "noindex, nofollow" }, { name: "referrer", content: "no-referrer" }] }),
  component: SharedEvent,
});

async function read<T>(path: string): Promise<T> {
  const response = await fetch(path);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not load event");
  return data as T;
}

function SharedEvent() {
  const { token } = Route.useParams();
  const { album } = Route.useSearch();
  const event = useQuery({ queryKey: ["public-event", token], retry: false,
    queryFn: () => read<{ event: { name: string }; albums: { id: string; name: string }[] }>(`/api/share/${encodeURIComponent(token)}`) });
  const navigate = useNavigate();
  const selected = event.data?.albums.find((a) => a.id === album) ?? event.data?.albums[0];
  return <AppShell wide>
    {event.isPending ? <p role="status">Loading event...</p> : event.isError ? <p role="alert">{event.error.message}</p> : <>
      <h1 className="mb-5 break-words text-3xl font-semibold">{event.data.event.name}</h1>
      {event.data.albums.length > 1 && <select aria-label="Event album" value={selected?.id}
        className="mb-6 max-w-full rounded-lg border border-hairline bg-secondary p-3"
        onChange={(e) => void navigate({ to: "/share/$token", params: { token }, search: { album: e.target.value } })}>
        {event.data.albums.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>}
      {selected ? <SharedAlbum key={token + selected.id} token={token} album={selected} /> : <p>No photos published yet.</p>}
    </>}
  </AppShell>;
}

function SharedAlbum({ token, album }: { token: string; album: { id: string; name: string } }) {
  const { user, loading } = useSession();
  const navigate = useNavigate();
  const [viewer, setViewer] = useState<number | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const query = useInfiniteQuery({
    queryKey: ["public-photos", token, album.id], initialPageParam: undefined as string | undefined, retry: false,
    queryFn: ({ pageParam }) => read<{ photos: GridPhoto[]; cursor?: string }>(
      `/api/share/${encodeURIComponent(token)}/photos/${album.id}${pageParam ? "?cursor=" + encodeURIComponent(pageParam) : ""}`),
    getNextPageParam: (last) => last.cursor,
  });
  useEffect(() => {
    const element = sentinel.current;
    if (!element || !query.hasNextPage || query.isFetching || query.isError) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) void query.fetchNextPage();
    }, { rootMargin: "900px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [query.hasNextPage, query.isFetching, query.isError, query.fetchNextPage]);
  const pages = stablePhotoPages(query.data?.pages);
  const photos = pages.flatMap((page) => page.photos);
  const signIn = (reason: string) => {
    setViewer(null);
    toast.info(`Sign in to ${reason}`, { duration: 10000, action: { label: "Sign in", onClick: () => {
      try { sessionStorage.setItem(SHARE_RETURN_KEY, `/share/${token}?album=${album.id}`); } catch { /* Storage is optional. */ }
      void navigate({ to: "/auth", search: { mode: "in" } });
    } } });
  };
  const download = (photo: ViewerPhoto) => {
    if (!user) { signIn("download the photo"); return; }
    void downloadPhoto(`/media/p/${album.id}/${photo.id}`, photo.fileName ?? undefined)
      .catch(() => toast.error("Could not download the original. Check your sign-in and try again."));
  };
  return <>
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <h2 className="min-w-0 break-words text-xl font-medium">{album.name}</h2>
      <GlassButton disabled={loading} icon={<ScanFace className="size-4" />} onClick={() => {
        if (!user) { signIn("find your photos"); return; }
        void navigate({ to: "/collections", search: { shared: album.id } });
      }}>Find me</GlassButton>
    </div>
    <PagedPhotoGrid pages={pages} onOpen={setViewer} />
    <div ref={sentinel} className="flex min-h-20 items-center justify-center">
      {query.isFetching ? <span role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-5 animate-spin" />Loading photos...</span>
        : query.isError ? <div role="alert">{query.error.message} <GlassButton size="sm" onClick={() => void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch())}>Retry</GlassButton></div>
        : query.hasNextPage ? <GlassButton onClick={() => void query.fetchNextPage()}>Load more</GlassButton>
        : !photos.length ? <p>No photos published yet.</p> : null}
    </div>
    {viewer !== null && <PhotoViewer photos={photos} index={viewer} onIndexChange={setViewer} onClose={() => setViewer(null)} onDownload={download} />}
  </>;
}
