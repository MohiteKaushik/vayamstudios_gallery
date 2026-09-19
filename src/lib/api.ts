/**
 * Browser side of the data API.
 *
 * Every call carries the session cookie and returns already-usable shapes:
 * photos arrive with the URLs to fetch them, so no screen has to know how a
 * storage key is built.
 */

import type { MemberRow } from "./members";
import type { ShowcaseEvent } from "./vayam";

export type Collection = {
  id: string;
  name: string;
  description: string | null;
  coverPhotoId: string | null;
  coverUrl: string | null;
  photoCount: number;
  createdBy: string;
  createdAt: number;
  showcaseEventId?: string;
};

export type Photo = {
  id: string;
  fileName: string;
  width: number;
  height: number;
  facesCount: number;
  thumbUrl: string;
  fullUrl: string;
  /** When it was uploaded. The console groups photos into batches by this. */
  createdAt: number;
  /** For duplicate detection. Null until the console has looked at this photo. */
  fingerprint: string | null;
};

export type ScanHit = {
  photoId: string;
  hops: number;
  /** 0 to 1. Multiply by 100 for the percentage shown to a member. */
  confidence: number;
  fileName: string;
  width: number;
  height: number;
  thumbUrl: string;
  fullUrl: string;
};

export type ScanResult = {
  hits: ScanHit[];
  /** Real matches the system is less sure about, offered rather than hidden. */
  possible: ScanHit[];
  scannedAt: number;
  /** Which matching settings produced this result. */
  matcher?: number;
  /** Where a scan spent its time, in milliseconds. Absent on older records. */
  timing?: { searchMs: number; readMs: number; statusMs: number; totalMs: number };
  facesSearched: number;
  /** Matches that could not be shown because their photo record was missing. */
  orphaned?: number;
  /** Why the result looks the way it does. See CollectionStatus for the counts. */
  state?: "ok" | "empty" | "not-processed" | "no-faces" | "indexing" | "no-match";
  index?: CollectionStatus;
};

export type CollectionStatus = {
  photos: number;
  processed: number;
  withFaces: number;
  faces: number;
  indexed: number;
  pending: number;
};

export class ApiError extends Error {
  code: string | undefined;
  status: number;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; code?: string };
      if (body.error) message = body.error;
      code = body.code;
    } catch {
      // Keep the status-based message.
    }
    throw new ApiError(message, res.status, code);
  }
  return (await res.json()) as T;
}

/**
 * Someone who searched an event and came up empty.
 *
 * At a live event this usually means the photographer has not reached them yet
 * rather than that they are absent from the photographs, which makes it a list
 * to act on rather than a log to read.
 */
/** A photo waiting in the recycle bin. */
export type BinPhoto = {
  id: string;
  fileName: string;
  width: number;
  height: number;
  createdAt: number;
  thumbUrl: string;
  fullUrl: string;
};

/** One entry in the recycle bin: a deleted selection of photos, or a whole event. */
export type BinEntry = {
  id: string;
  kind: "photos" | "event";
  collectionId: string;
  collectionName: string;
  /** For a selection, the photos still in the bin. */
  photoIds: string[];
  /** For an event, how many photos it held when it was deleted. */
  photoCount: number;
  deletedAt: number;
  deletedBy: string;
  expiresAt: number;
  preview?: BinPhoto[];
};

export type WaitingRow = {
  userId: string;
  fullName: string;
  email: string;
  phone: string;
  collectionId: string;
  collectionName: string;
  firstAskedAt: number;
  lastAskedAt: number;
  attempts: number;
  hasReference: boolean;
};

export const api = {
  adminPhotoSearch: (
    input: { collectionId: string } & ({ userId: string } | { references: number[][] }),
    signal?: AbortSignal,
  ) => call<{ hits: ScanHit[]; truncated: boolean; collectionName: string }>("/api/admin/photo-search", {
    method: "POST", body: JSON.stringify(input), ...(signal ? { signal } : {}),
  }),
  unindexedPhotos: (collectionId: string) =>
    call<{ photoIds: string[]; total: number; indexed: number }>(
      `/api/collections/${collectionId}/unindexed`,
    ),

  listWaiting: () => call<{ waiting: WaitingRow[] }>("/api/waiting").then((r) => r.waiting),

  listMembers: () =>
    call<{ members: MemberRow[] }>("/api/members").then((r) => r.members),

  me: () => call<{ id: string; email: string; role: string; onboarded: boolean }>("/api/me"),

  listCollections: () =>
    call<{ collections: Collection[] }>("/api/collections").then((r) => r.collections),

  listRecentCollections: () =>
    call<{ collections: Collection[] }>("/api/collections?recent=1").then((r) => r.collections),
  listEventCollections: (eventId: string) =>
    call<{ collections: Collection[]; event: ShowcaseEvent }>(`/api/collections?event=${encodeURIComponent(eventId)}`),

  showcaseEvents: () => call<{ events: ShowcaseEvent[] }>("/api/site/events").then((r) => r.events),
  setEventHidden: (id: string, hidden: boolean) => call<{ events: ShowcaseEvent[] }>("/api/site/events", {
    method: "PUT", body: JSON.stringify({ id, hidden }),
  }).then((r) => r.events),
  deleteShowcaseEvent: (id: string) => call<{ groupIds: string[] }>("/api/site/events", {
    method: "DELETE", body: JSON.stringify({ id, confirmed: true }),
  }),
  setRecentEvent: (id: string, recent: boolean) => call<{ events: ShowcaseEvent[] }>("/api/site/events", {
    method: "PATCH", body: JSON.stringify({ id, recent }),
  }).then((r) => r.events),

  createCollection: (name: string, description?: string, recent = true) =>
    call<Collection>("/api/collections", {
      method: "POST",
      body: JSON.stringify({ name, description, recent }),
    }),
  createEventSubfolder: (eventId: string, name: string, description?: string) =>
    call<Collection>("/api/collections", {
      method: "POST",
      body: JSON.stringify({ eventId, name, description }),
    }),

  listPhotos: (collectionId: string, cursor?: string, limit = 40, filename = "") =>
    call<{ photos: Photo[]; cursor?: string }>(
      `/api/collections/${collectionId}/photos?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}${filename ? `&filename=${encodeURIComponent(filename)}` : ""}`,
    ),

  /** Every photo in a collection, following the pages. */
  async allPhotos(collectionId: string): Promise<Photo[]> {
    const out: Photo[] = [];
    let cursor: string | undefined;
    do {
      const page = await api.listPhotos(collectionId, cursor);
      out.push(...page.photos);
      cursor = page.cursor;
    } while (cursor);
    // Newest first across the whole event. Storage lists photos by id, and ids
    // are random, so each page arrives in no useful order and only sorting the
    // complete list puts the latest upload at the top.
    return out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  },

  saveFaceProfile: (references: number[][], imageKey?: string) =>
    call<{ ok: true; references: number }>("/api/face-profile", {
      method: "POST",
      body: JSON.stringify({ references, imageKey }),
    }),

  scan: (collectionId: string) =>
    call<ScanResult>("/api/scan", {
      method: "POST",
      body: JSON.stringify({ collectionId }),
    }),

  cachedScan: (collectionId: string) => call<ScanResult>(`/api/scan/${collectionId}`),

  collectionStatus: (collectionId: string) =>
    call<CollectionStatus>(`/api/collections/${collectionId}/status`),

  /** Rebuilds the search index for a collection from the descriptors in R2. */
  reindex: (collectionId: string) =>
    call<{ photos: number; vectors: number }>(`/api/collections/${collectionId}/reindex`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  forgetFace: () =>
    call<{ ok: true; clearedScans: number }>("/api/face-profile", { method: "DELETE" }),

  /** Deletes named photos, or the whole collection when none are named. */
  /**
   * Moves photos, or a whole event when `photos` is left out, to the recycle
   * bin. `groupId` adds this request to the entry an earlier slice made.
   */
  deletePhotos: (collectionId: string, photos?: string[], groupId?: string) =>
    call<{ deleted: number; collectionRemoved: boolean; groupId: string | null }>("/media/delete", {
      method: "POST",
      body: JSON.stringify({
        collection: collectionId,
        ...(photos ? { photos } : {}),
        ...(groupId ? { groupId } : {}),
      }),
    }),

  saveFingerprints: (collectionId: string, items: { photoId: string; fingerprint: string }[]) =>
    call<{ saved: number }>(`/api/collections/${collectionId}/fingerprints`, {
      method: "POST",
      body: JSON.stringify({ items }),
    }),

  pastEventRenames: () =>
    call<{ renames: Record<string, string> }>("/api/site/past-events").then((r) => r.renames),

  renamePastEvent: (id: string, title: string) =>
    call<{ renames: Record<string, string> }>("/api/site/past-events", {
      method: "PUT",
      body: JSON.stringify({ id, title }),
    }).then((r) => r.renames),

  homeCover: () =>
    call<{ coverUrl: string | null; collectionId: string | null; photoId: string | null }>("/api/site/cover"),

  setHomeCover: (collectionId: string, photoId: string) =>
    call<{ coverUrl: string | null }>("/api/site/cover", {
      method: "PUT",
      body: JSON.stringify({ collectionId, photoId }),
    }),

  clearHomeCover: () => call<{ coverUrl: null }>("/api/site/cover", { method: "DELETE" }),

  renameCollection: (collectionId: string, name: string) =>
    call<Collection>(`/api/collections/${collectionId}`, { method: "PATCH", body: JSON.stringify({ name }) }),

  listBin: () => call<{ groups: BinEntry[] }>("/api/bin").then((r) => r.groups),

  binEntry: (id: string) => call<{ group: BinEntry; photos: BinPhoto[] }>(`/api/bin/${encodeURIComponent(id)}`),

  restoreFromBin: (id: string, photos?: string[]) =>
    call<{ restored: number; remaining: number; collectionId: string }>(
      `/api/bin/${encodeURIComponent(id)}/restore`,
      { method: "POST", body: JSON.stringify(photos ? { photos } : {}) },
    ),

  deleteFromBin: (id: string, photos?: string[]) =>
    call<{ deleted: number; remaining: number }>(`/api/bin/${encodeURIComponent(id)}/delete`, {
      method: "POST",
      body: JSON.stringify(photos ? { photos } : {}),
    }),
};

/** The percentage a member sees next to a match. */
export const confidencePercent = (confidence: number) => Math.round(confidence * 100);
