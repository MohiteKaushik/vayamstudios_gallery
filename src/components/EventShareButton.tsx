import { useState } from "react";
import { Copy, Share2 } from "lucide-react";
import { toast } from "sonner";
import { GlassButton } from "./ui-kit";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";

export function EventShareButton({ eventId, name, disabled }: { eventId: string; name: string; disabled?: boolean }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); toast.success("Event link copied"); }
    catch { toast.info("Select and copy the link below"); }
  };
  return <>
    <GlassButton size="sm" disabled={disabled} loading={busy} icon={<Share2 className="size-4" />}
      title={disabled ? "Unhide this event to share it" : "Share event"}
      onClick={async () => {
        setBusy(true);
        try {
          const response = await fetch("/api/site/events/share", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: eventId }) });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "Could not share event");
          const value = new URL(data.path, window.location.origin).href;
          setUrl(value);
          await copy(value);
        } catch (error) { toast.error(error instanceof Error ? error.message : "Could not share event"); }
        finally { setBusy(false); }
      }}>Share</GlassButton>
    <Dialog open={!!url} onOpenChange={(open) => { if (!open) setUrl(""); }}>
      <DialogContent className="w-[calc(100%-2rem)] max-w-lg rounded-lg">
        <DialogHeader><DialogTitle className="break-words pr-5">Share {name}</DialogTitle>
          <DialogDescription>Anyone with this link can view previews. Sign-in is required to download originals or find their photos.</DialogDescription>
        </DialogHeader>
        <input aria-label="Event share link" readOnly value={url} onFocus={(e) => e.target.select()}
          className="w-full min-w-0 rounded-lg border border-hairline bg-secondary p-3 text-sm" />
        <GlassButton icon={<Copy className="size-4" />} onClick={() => void copy(url)}>Copy link</GlassButton>
      </DialogContent>
    </Dialog>
  </>;
}
