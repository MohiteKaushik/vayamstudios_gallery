import { supabase } from "@/integrations/supabase/client";
import {
  ANALYSIS_MAX_EDGE,
  MATCH_MAX_DISTANCE,
  MIN_FACE_PX,
  averageDescriptors,
  bestMatch,
  detectFaces,
  detectFacesThorough,
  packReferences,
  similarity,
} from "./face";
import { canvasToBlob, downscale, fileToImage, mirror } from "./images";
import { encodeImage, extensionFor } from "./encode";


export type Progress = {
  processed: number;
  total: number;
  matches: number;
  faces: number;
  failed: number;
  current?: string;
  /** Bytes handed in by the admin, before re-encoding. Uploads only. */
  bytesIn?: number;
  /** Bytes actually stored. The gap between the two is what the codec saved. */
  bytesOut?: number;
};

const STORE_MAX_EDGE = 2048;

/**
 * Runs the whole search on-device: upload a privacy-friendly copy of each photo,
 * detect faces, compare against the user's reference embedding, persist results.
 */
export async function runSearch(opts: {
  userId: string;
  files: File[];
  reference: number[];
  name: string;
  onProgress: (p: Progress) => void;
  signal?: AbortSignal;
}) {
  const { userId, files, reference, name, onProgress } = opts;

  const { data: session, error: sErr } = await supabase
    .from("search_sessions")
    .insert({ user_id: userId, name, status: "processing", total_photos: files.length, threshold: MATCH_MAX_DISTANCE })
    .select("id")
    .single();
  if (sErr || !session) throw sErr ?? new Error("Could not start search");

  const p: Progress = { processed: 0, total: files.length, matches: 0, faces: 0, failed: 0, bytesIn: 0, bytesOut: 0 };
  onProgress({ ...p });

  for (const file of files) {
    if (opts.signal?.aborted) break;
    p.current = file.name;
    onProgress({ ...p });
    try {
      const img = await fileToImage(file);
      const stored = downscale(img, STORE_MAX_EDGE);
      const blob = await canvasToBlob(stored.canvas, 0.86);
      const path = `${userId}/${session.id}/${crypto.randomUUID()}.jpg`;

      const { error: upErr } = await supabase.storage
        .from("photos")
        .upload(path, blob, { contentType: "image/jpeg", upsert: false });
      if (upErr) throw upErr;

      const { data: photo, error: pErr } = await supabase
        .from("photos")
        .insert({
          user_id: userId,
          session_id: session.id,
          storage_path: path,
          file_name: file.name,
          width: stored.canvas.width,
          height: stored.canvas.height,
          status: "processing",
        })
        .select("id")
        .single();
      if (pErr || !photo) throw pErr ?? new Error("Insert failed");

      const analysis = downscale(img, ANALYSIS_MAX_EDGE);
      const faces = await detectFaces(analysis.canvas);
      const scale = stored.canvas.width / analysis.canvas.width;
      const best = bestMatch(reference, faces);
      const isMatch = !!best && best.dist <= MATCH_MAX_DISTANCE;
      const bestSim = best ? similarity(reference, best.face.descriptor) : null;

      if (faces.length) {
        await supabase.from("face_detections").insert(
          faces.map((f) => ({
            user_id: userId,
            photo_id: photo.id,
            box: {
              x: Math.round(f.box.x * scale),
              y: Math.round(f.box.y * scale),
              width: Math.round(f.box.width * scale),
              height: Math.round(f.box.height * scale),
            },
            descriptor: f.descriptor,
            similarity: similarity(reference, f.descriptor),
          })),
        );
      }

      await supabase
        .from("photos")
        .update({ status: "done", faces_count: faces.length, best_similarity: bestSim, is_match: isMatch })
        .eq("id", photo.id);

      p.faces += faces.length;
      if (isMatch) p.matches += 1;
    } catch (e) {
      console.error(e);
      p.failed += 1;
    }
    p.processed += 1;
    onProgress({ ...p });
    await supabase
      .from("search_sessions")
      .update({
        processed_photos: p.processed,
        faces_detected: p.faces,
        matches_found: p.matches,
        failed_photos: p.failed,
      })
      .eq("id", session.id);
  }

  await supabase
    .from("search_sessions")
    .update({ status: opts.signal?.aborted ? "cancelled" : "complete", completed_at: new Date().toISOString() })
    .eq("id", session.id);

  return { sessionId: session.id, ...p };
}

/**
 * Admin upload: store photos into a shared collection and index every face so
 * members can be matched against them later without re-processing.
 */
export async function indexSharedPhotos(opts: {
  userId: string;
  collectionId: string;
  files: File[];
  onProgress: (p: Progress) => void;
}) {
  const { userId, collectionId, files, onProgress } = opts;
  const p: Progress = { processed: 0, total: files.length, matches: 0, faces: 0, failed: 0, bytesIn: 0, bytesOut: 0 };
  onProgress({ ...p });
  let firstPath: string | null = null;

  for (const file of files) {
    p.current = file.name;
    onProgress({ ...p });
    try {
      const img = await fileToImage(file);
      const stored = downscale(img, STORE_MAX_EDGE);
      // Encoded with the best codec this browser can actually produce, at a
      // quality that stays visually lossless. A PNG straight from a camera or a
      // design tool typically lands here several times smaller with nothing
      // visible given up. See encode.ts.
      const encoded = await encodeImage(stored.canvas);
      const path = `shared/${collectionId}/${crypto.randomUUID()}.${extensionFor(encoded.format)}`;
      const { error: upErr } = await supabase.storage
        .from("photos")
        .upload(path, encoded.blob, { contentType: encoded.format });
      if (upErr) throw upErr;
      firstPath ??= path;
      p.bytesIn = (p.bytesIn ?? 0) + file.size;
      p.bytesOut = (p.bytesOut ?? 0) + encoded.blob.size;

      // Several passes over the frame, not one. A single downscaled pass loses
      // every face that is small in the original, and a face that was never
      // detected can never be matched however good the search is.
      const analysis = await detectFacesThorough(img);
      const faces = analysis.faces;
      const scale = stored.canvas.width / analysis.canvas.width;

      const { data: photo, error: pErr } = await supabase
        .from("shared_photos")
        .insert({
          collection_id: collectionId,
          storage_path: path,
          file_name: file.name,
          width: stored.canvas.width,
          height: stored.canvas.height,
          faces_count: faces.length,
          uploaded_by: userId,
        })
        .select("id")
        .single();
      if (pErr || !photo) throw pErr ?? new Error("Insert failed");

      if (faces.length) {
        const { error: fErr } = await supabase.from("shared_faces").insert(
          faces.map((f) => ({
            photo_id: photo.id,
            collection_id: collectionId,
            descriptor: f.descriptor,
            box: {
              x: Math.round(f.box.x * scale),
              y: Math.round(f.box.y * scale),
              width: Math.round(f.box.width * scale),
              height: Math.round(f.box.height * scale),
            },
          })),
        );
        if (fErr) throw fErr;
      }
      p.faces += faces.length;
    } catch (e) {
      console.error(e);
      p.failed += 1;
    }
    p.processed += 1;
    onProgress({ ...p });
  }

  if (firstPath) {
    await supabase
      .from("shared_collections")
      .update({ cover_path: firstPath })
      .eq("id", collectionId)
      .is("cover_path", null);
  }
  return p;
}

/** Builds the reference embeddings from a selfie and stores them. Returns an error message if no usable face. */
export async function saveFaceProfile(userId: string, file: File) {
  const img = await fileToImage(file);
  const analysis = downscale(img, ANALYSIS_MAX_EDGE);
  const faces = await detectFaces(analysis.canvas);
  if (faces.length === 0) return { error: "We couldn't find a face. Try a clearer, front-facing photo." };
  if (faces.length > 1) return { error: "More than one face was found. Use a photo with only you in it." };

  const face = faces[0]!;
  if (Math.min(face.box.width, face.box.height) < MIN_FACE_PX)
    return { error: "Your face is too small in this photo. Use a closer, front-facing shot." };
  if (face.score < 0.75)
    return { error: "That photo isn't clear enough. Try better lighting and look at the camera." };

  // Three views of one selfie: the raw reading, its mirror, and the average of
  // the two. All near-frontal, so this is not angular coverage; that is
  // gathered afterwards, from the member's own confirmed matches in a real
  // collection. Holding all three still helps, because each is slightly
  // differently wrong about lighting and alignment.
  const flipped = await detectFaces(mirror(analysis.canvas));
  const references: number[][] = [face.descriptor];
  if (flipped.length === 1) {
    references.unshift(averageDescriptors([face.descriptor, flipped[0]!.descriptor]));
    references.push(flipped[0]!.descriptor);
  }
  const descriptor = packReferences(references);

  const preview = downscale(img, 512);
  const encoded = await encodeImage(preview.canvas);
  const path = `${userId}/profile/${crypto.randomUUID()}.${extensionFor(encoded.format)}`;
  const { error: upErr } = await supabase.storage
    .from("photos")
    .upload(path, encoded.blob, { contentType: encoded.format });
  if (upErr) return { error: upErr.message };

  await supabase.from("face_profiles").delete().eq("user_id", userId);
  const { error } = await supabase
    .from("face_profiles")
    .insert({ user_id: userId, image_path: path, descriptor });
  if (error) return { error: error.message };
  await supabase.from("profiles").update({ onboarded: true }).eq("id", userId);
  return { error: null };
}

