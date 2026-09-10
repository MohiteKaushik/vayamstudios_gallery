/**
 * Browser side of the data API.
 *
 * Every call carries the session cookie and returns already-usable shapes:
 * photos arrive with the URLs to fetch them, so no screen has to know how a
 * storage key is built.
 */

import type { MemberRow } from "./members";

export type Collection = {
  id: string;
  name: string;
  description: string | null;
  coverPhotoId: string | null;
  coverUrl: string | null;
  photoCount: number;
  createdBy: string;
  createdAt: number;
};

export type Photo = {
  id: string;
  fileName: string;
  width: number;
  height: number;
  facesCount: number;
  thumbUrl: string;
  fullUrl: string;
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

export const api = {
  listMembers: () =>
    call<{ members: MemberRow[] }>("/api/members").then((r) => r.members),

  me: () => call<{ id: string; email: string; role: string; onboarded: boolean }>("/api/me"),

  listCollections: () =>
    call<{ collections: Collection[] }>("/api/collections").then((r) => r.collections),

  createCollection: (name: string, description?: string) =>
    call<Collection>("/api/collections", {
      method: "POST",
      body: JSON.stringify({ name, description }),
    }),

  listPhotos: (collectionId: string, cursor?: string) =>
    call<{ photos: Photo[]; cursor?: string }>(
      `/api/collections/${collectionId}/photos${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
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
    return out;
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
  deletePhotos: (collectionId: string, photos?: string[]) =>
    call<{ deleted: number; collectionRemoved: boolean }>("/media/delete", {
      method: "POST",
      body: JSON.stringify({ collection: collectionId, ...(photos ? { photos } : {}) }),
    }),
};

/** The percentage a member sees next to a match. */
export const confidencePercent = (confidence: number) => Math.round(confidence * 100);
