import { supabase } from "@/integrations/supabase/client";

const cache = new Map<string, { url: string; expires: number }>();

/** Signed URLs for private storage objects, cached until shortly before expiry. */
export async function signedUrls(paths: string[], expiresIn = 3600) {
  const now = Date.now();
  const missing = paths.filter((p) => {
    const hit = cache.get(p);
    return !hit || hit.expires < now + 60_000;
  });

  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    const { data } = await supabase.storage.from("photos").createSignedUrls(chunk, expiresIn);
    data?.forEach((entry) => {
      if (entry.signedUrl && entry.path) {
        cache.set(entry.path, { url: entry.signedUrl, expires: now + expiresIn * 1000 });
      }
    });
  }

  const out: Record<string, string> = {};
  paths.forEach((p) => {
    const hit = cache.get(p);
    if (hit) out[p] = hit.url;
  });
  return out;
}

export async function signedUrl(path: string, expiresIn = 3600) {
  const map = await signedUrls([path], expiresIn);
  return map[path] ?? null;
}

export async function downloadPhoto(path: string, fileName?: string) {
  const { data, error } = await supabase.storage.from("photos").download(path);
  if (error || !data) throw error ?? new Error("Download failed");
  const url = URL.createObjectURL(data);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName || path.split("/").pop() || "photo.jpg";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}
