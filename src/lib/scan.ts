/**
 * "Find me" for a shared collection.
 *
 * The whole search now runs on the member's device. Every face in the
 * collection is pulled down once, compared exactly rather than approximately,
 * and walked outward through the collection's own face graph so that turned
 * heads and profiles are reached. See face-search.ts for why the walk is
 * necessary and how it is kept from drifting onto strangers.
 *
 * What changed, and why the old results were thin: the previous version asked
 * the database to compare each face to the member's single selfie once. That
 * finds frontal shots and very little else, because a profile sits further from
 * a frontal selfie than a stranger's frontal does. It also unpacked every
 * descriptor in SQL on every scan, which is why large collections crawled.
 */

import { supabase } from "@/integrations/supabase/client";
import { MATCH_MAX_DISTANCE, MAX_REFERENCES, packReferences, unpackReferences } from "./face";
import { buildFaceSet, harvestReferences, searchFaceSet, type SearchResult } from "./face-search";

export type ScanProgress = {
  processed: number;
  total: number;
  matches: number;
  faces: number;
  failed: number;
  current?: string;
};

const FACE_PAGE = 1000;

/** 0..1 for display only. A straight rescale of distance, not a probability. */
const toSimilarity = (distance: number) => Math.max(0, Math.min(1, 1 - distance / 1.1));

export class NoFaceProfileError extends Error {
  constructor() {
    super("Add a reference photo of yourself first.");
    this.name = "NoFaceProfileError";
  }
}

export async function loadReferences(userId: string): Promise<number[][]> {
  const { data, error } = await supabase
    .from("face_profiles")
    .select("descriptor")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  const references = unpackReferences(data?.descriptor);
  if (references.length === 0) throw new NoFaceProfileError();
  return references;
}

/**
 * Pulls every indexed face in a collection. Paged, because Supabase caps a
 * single response and a large event runs to tens of thousands of faces.
 */
async function loadCollectionFaces(
  collectionId: string,
  onPage: (loaded: number) => void,
): Promise<{ id: string; photo_id: string; descriptor: number[] }[]> {
  const rows: { id: string; photo_id: string; descriptor: number[] }[] = [];
  for (let from = 0; ; from += FACE_PAGE) {
    const { data, error } = await supabase
      .from("shared_faces")
      .select("id, photo_id, descriptor")
      .eq("collection_id", collectionId)
      .range(from, from + FACE_PAGE - 1);
    if (error) throw error;
    const page = data ?? [];
    rows.push(...(page as typeof rows));
    onPage(rows.length);
    if (page.length < FACE_PAGE) break;
  }
  return rows;
}

export type ScanOutcome = {
  matched: number;
  facesScanned: number;
  seedFaces: number;
  linkedFaces: number;
  referencesLearned: number;
};

export async function scanSharedCollection(opts: {
  userId: string;
  collectionId: string;
  onProgress: (p: ScanProgress) => void;
  signal?: AbortSignal;
}): Promise<ScanOutcome> {
  const { userId, collectionId, onProgress } = opts;

  const references = await loadReferences(userId);

  const p: ScanProgress = { processed: 0, total: 0, matches: 0, faces: 0, failed: 0 };
  const report = (current: string) => {
    p.current = current;
    onProgress({ ...p });
  };
  report("Loading faces in this collection");

  const { count } = await supabase
    .from("shared_faces")
    .select("id", { count: "exact", head: true })
    .eq("collection_id", collectionId);
  p.total = count ?? 0;
  report("Loading faces in this collection");

  const rows = await loadCollectionFaces(collectionId, (loaded) => {
    p.processed = Math.min(loaded, p.total || loaded);
    p.faces = loaded;
    report("Loading faces in this collection");
  });

  if (opts.signal?.aborted) throw new Error("Cancelled");

  const set = buildFaceSet(rows);
  p.total = set.faceIds.length;
  p.processed = set.faceIds.length;
  p.faces = set.faceIds.length;
  report("Matching against your face");

  let result: SearchResult;
  try {
    result = searchFaceSet(set, {
      references,
      threshold: MATCH_MAX_DISTANCE,
      onProgress: (round, photos) => {
        p.matches = photos;
        report(round === 0 ? "Matching against your face" : `Reaching photos at other angles (${round})`);
      },
    });
  } catch (e) {
    p.failed = 1;
    throw e;
  }

  p.matches = result.hits.length;
  report("Saving your results");

  // Replace this member's results for this collection, then write the new set.
  await supabase.from("scan_results").delete().eq("user_id", userId).eq("collection_id", collectionId);

  if (result.hits.length) {
    const rowsToInsert = result.hits.map((h) => ({
      user_id: userId,
      collection_id: collectionId,
      photo_id: h.photoId,
      similarity: toSimilarity(h.distance),
    }));
    for (let i = 0; i < rowsToInsert.length; i += 500) {
      const { error } = await supabase.from("scan_results").insert(rowsToInsert.slice(i, i + 500));
      if (error) throw error;
    }
  }

  // Learn the angles this collection showed us. The member does nothing and
  // sees no extra screen; their next scan simply starts from several views of
  // their face instead of one, and reaches turned heads in the first round.
  let referencesLearned = 0;
  const grown = harvestReferences(set, result, references, MAX_REFERENCES);
  if (grown.length > references.length) {
    referencesLearned = grown.length - references.length;
    const { error } = await supabase
      .from("face_profiles")
      .update({ descriptor: packReferences(grown) })
      .eq("user_id", userId);
    if (error) referencesLearned = 0; // not worth failing the scan over
  }

  return {
    matched: result.hits.length,
    facesScanned: result.stats.facesScanned,
    seedFaces: result.stats.seedFaces,
    linkedFaces: result.stats.linkedFaces,
    referencesLearned,
  };
}
