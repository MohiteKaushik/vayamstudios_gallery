import { useQuery } from "@tanstack/react-query";
import { Download, ImagePlus, UserRound, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { WaitingPanel } from "./WaitingPanel";
import { GlassButton } from "./ui-kit";
import { api, ApiError, type WaitingRow } from "@/lib/api";
import { choosePhotoDirectory, downloadPhotos } from "@/lib/photo-download";
import { waitingSelection } from "@/lib/waiting-selection";

export function AdminPhotoTools() {
  const collections = useQuery({ queryKey: ["export-collections"], queryFn: api.listCollections });
  const [collectionId, setCollectionId] = useState<string | null>(null);
  const [member, setMember] = useState<ReturnType<typeof waitingSelection> | null>(null);
  const [name, setName] = useState("");
  const [references, setReferences] = useState<number[][] | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [archive, setArchive] = useState<{ url: string; name: string } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const panel = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const selectedEvent = collectionId ?? collections.data?.[0]?.id ?? "";

  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!file) { setPreview(""); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  useEffect(() => () => { if (archive) URL.revokeObjectURL(archive.url); }, [archive]);

  async function pick(file: File | undefined) {
    if (!file || controller.current || member) return;
    setArchive(null);
    setReferences(null);
    setFile(null);
    setMessage("");
    if (!file.type.startsWith("image/") || file.size > 25 * 1024 * 1024) {
      setError("Choose an image smaller than 25 MB.");
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setReferences(null);
    setFile(file);
    setError("");
    setMessage("Preparing face reference...");
    try {
      const { referenceFromPhoto } = await import("@/lib/reference-photo");
      const refs = await referenceFromPhoto(file);
      abort.signal.throwIfAborted();
      setReferences(refs);
      setMessage("Reference ready");
    } catch (e) {
      if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "Could not read the photo");
      setMessage(abort.signal.aborted ? "Cancelled" : "");
    } finally {
      controller.current = null;
      setBusy(false);
    }
  }

  async function run(row?: WaitingRow, zipOnly = false) {
    if (controller.current) return;
    const cid = row?.collectionId || selectedEvent;
    const person = row ? waitingSelection(row) : member;
    if (row) {
      setMember(person);
      setName(person!.fullName);
      setCollectionId(cid);
      setReferences(null);
      setFile(null);
    }
    if (!cid || (!person && !references)) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError("");
    setMessage("Choose a download folder...");
    setArchive(null);
    let saved = 0;
    try {
      // Never silently substitute a different event for an old waiting entry.
      if (row && collections.data && !collections.data.some((event) => event.id === cid)) {
        setCollectionId("");
        setError(`The event from ${person!.fullName}'s earlier search is unavailable. Choose the current event below; their saved reference is selected.`);
        setMessage("");
        void collections.refetch();
        panel.current?.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      // Must be requested while the download button still has user activation.
      const directory = zipOnly ? null : await choosePhotoDirectory();
      abort.signal.throwIfAborted();
      if (row) panel.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      setMessage(`Finding photos for ${person?.fullName || name || "this person"}...`);
      let result;
      try {
        result = await api.adminPhotoSearch(
          person ? { collectionId: cid, userId: person.userId } : { collectionId: cid, references: references! },
          abort.signal,
        );
      } catch (e) {
        if (!(e instanceof ApiError) || e.code !== "no-face" || !person) throw e;
        // Old or missing embeddings can be rebuilt locally from the member's
        // saved crop. Do not replace their profile or upload the image again.
        setMessage(`Preparing ${person.fullName}'s saved reference...`);
        const response = await fetch(person.referenceUrl, { credentials: "same-origin", signal: abort.signal });
        if (!response.ok) throw new Error(response.status === 404
          ? "This member has no saved face profile or reference image. They need to add their reference in Settings."
          : "Could not load the saved reference. Please retry.");
        const blob = await response.blob();
        const { referenceFromPhoto } = await import("@/lib/reference-photo");
        let savedRefs: number[][];
        try {
          savedRefs = await referenceFromPhoto(new File([blob], "saved-reference.jpg", { type: blob.type }));
        } catch (error) {
          abort.signal.throwIfAborted();
          throw new Error("The saved reference could not be processed. Retry, or ask the member to update their reference in Settings.", { cause: error });
        }
        abort.signal.throwIfAborted();
        result = await api.adminPhotoSearch({ collectionId: cid, references: savedRefs }, abort.signal);
      }
      if (!result.hits.length) {
        setMessage("No matching photos found. Nothing was downloaded.");
        return;
      }
      const label = `${person?.fullName || name || "Person"}-${result.collectionName}`;
      setMessage(`Downloading 0 of ${result.hits.length} photos...`);
      const download = await downloadPhotos(result.hits, directory, label, abort.signal, (count, total) => {
        saved = count;
        setMessage(`Downloading ${count} of ${total} photos...`);
      });
      if (download.blob) {
        const url = URL.createObjectURL(download.blob);
        const filename = `${download.folder}.zip`;
        setArchive({ url, name: filename });
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.append(link);
        link.click();
        link.remove();
      }
      setMessage(download.blob
        ? `ZIP ready: ${download.saved} matched photos for ${person?.fullName || name || "this person"}.`
        : `Saved ${download.saved} photos in ${download.folder}.`);
      const warnings = [
        download.failed.length ? `${download.failed.length} photos could not be saved: ${download.failed.slice(0, 3).join(", ")}. Retry to download them.` : "",
        result.truncated ? "The search reached its result limit; this download may not contain every match." : "",
      ].filter(Boolean);
      if (warnings.length) setError(warnings.join(" "));
    } catch (e) {
      if (e instanceof ApiError && e.code === "no-event") {
        setCollectionId("");
        void collections.refetch();
        setMessage("");
        setError("The original event is unavailable. Choose the current event below. The selected person and reference have been kept.");
        panel.current?.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      const cancelled = abort.signal.aborted || (e instanceof DOMException && e.name === "AbortError");
      setMessage(cancelled ? `Cancelled. ${saved} photos processed; already saved files remain in your folder.` : "");
      if (!cancelled) setError((e instanceof Error ? e.message : "Download failed") +
        (saved ? ` ${saved} photos were processed before the error.` : ""));
    } finally {
      controller.current = null;
      setBusy(false);
    }
  }

  return (
    <>
      <WaitingPanel onDownloadPhotos={(row) => void run(row)} onReferencePhoto={(row) => void run(row)} downloadBusy={busy} />
      <section ref={panel} className="mt-10 border-t border-hairline pt-8" aria-labelledby="photo-export-title">
        <h2 id="photo-export-title" className="text-sm font-medium uppercase text-muted-foreground">{member ? "Download member photos" : "Download by reference photo"}</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="min-w-0 text-sm">
            Event
            <select aria-label="Download event" value={selectedEvent} disabled={busy || collections.isLoading}
              onChange={(e) => setCollectionId(e.target.value)}
              className="mt-2 block w-full min-w-0 rounded-lg border border-hairline bg-secondary p-3">
              <option value="">Choose event</option>
              {selectedEvent && !collections.data?.some((event) => event.id === selectedEvent) &&
                <option value={selectedEvent} disabled>Original event (unavailable)</option>}
              {collections.data?.map((event) => <option key={event.id} value={event.id}>{event.name}</option>)}
            </select>
          </label>
          <label className="min-w-0 text-sm">
            {member ? "Member name" : "Person name (optional)"}
            <input value={member?.fullName ?? name} onChange={(e) => setName(e.target.value)} disabled={busy} readOnly={!!member} maxLength={80}
              className="mt-2 block w-full min-w-0 rounded-lg border border-hairline bg-secondary p-3" />
          </label>
        </div>
        {member && <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
          <SavedMemberReference key={member.userId} member={member} />
          <GlassButton variant="quiet" size="sm" disabled={busy} icon={<X className="size-4" />}
            onClick={() => { setMember(null); setName(""); setReferences(null); setFile(null); setArchive(null); setMessage(""); setError(""); }}>
            Clear member
          </GlassButton>
        </div>}
        {collections.isError && <p role="alert" className="mt-3 text-sm text-destructive">Could not load events. <button className="underline" onClick={() => void collections.refetch()}>Retry</button></p>}
        {!member && <input ref={input} aria-label="Person reference photo" type="file" accept="image/*" className="hidden"
          onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {!member && preview && <img src={preview} alt="Selected reference" className="size-16 rounded-lg object-cover" />}
          {!member && <GlassButton variant="quiet" icon={<ImagePlus className="size-4" />} disabled={busy}
            onClick={() => input.current?.click()}>{file ? "Replace reference" : "Choose person photo"}</GlassButton>}
          <GlassButton icon={<Download className="size-4" />} disabled={busy || (!references && !member) || !selectedEvent}
            onClick={() => void run()}>Download photos</GlassButton>
          <GlassButton variant="quiet" icon={<Download className="size-4" />} disabled={busy || (!references && !member) || !selectedEvent}
            onClick={() => void run(undefined, true)}>Download ZIP</GlassButton>
          {busy && <GlassButton variant="quiet" icon={<X className="size-4" />} onClick={() => controller.current?.abort()}>Cancel</GlassButton>}
        </div>
        <p role="status" aria-live="polite" className="mt-3 break-words text-sm text-muted-foreground">{message}</p>
        {error && <p role="alert" className="mt-2 break-words text-sm text-destructive">{error}</p>}
        {archive && <a href={archive.url} download={archive.name} className="mt-3 inline-flex items-center gap-2 text-sm underline">
          <Download className="size-4" />Save ZIP
        </a>}
      </section>
    </>
  );
}

function SavedMemberReference({ member }: { member: ReturnType<typeof waitingSelection> }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-secondary">
        {failed ? <UserRound className="size-6 text-muted-foreground" /> :
          <img src={member.referenceUrl} alt={`Saved reference for ${member.fullName}`}
            className="size-full object-cover" onError={() => setFailed(true)} />}
      </div>
      <div className="min-w-0">
        <p className="break-words font-medium">{member.fullName}</p>
        <p className="text-xs text-muted-foreground">{failed ? "Member selected; photo preview unavailable" : "Saved member reference"}</p>
      </div>
    </div>
  );
}
