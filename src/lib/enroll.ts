/**
 * Creating a member's face profile from a selfie.
 *
 * Everything that touches the photograph happens here, in the browser. The
 * server receives embeddings, never the image used to make them, so a member's
 * face is analysed on their own machine and only the numbers travel.
 */

import {
  ANALYSIS_MAX_EDGE,
  MAX_REFERENCES,
  MIN_FACE_PX,
  averageDescriptors,
  detectFaces,
} from "./face";
import { canvasToBlob, downscale, fileToImage, mirror } from "./images";
import { api } from "./api";

export type EnrolResult = { error: string | null; references?: number };

/**
 * Reads a selfie, checks it is usable, and stores the references.
 *
 * The quality gates are worth being strict about. A blurred or tiny face
 * produces an embedding that is confidently wrong, and every later search is
 * measured against it, so one bad enrolment quietly ruins every scan the member
 * ever runs. Better to refuse the photo than to accept it and be wrong later.
 */
export async function enrolFace(file: File): Promise<EnrolResult> {
  const img = await fileToImage(file);
  const analysis = downscale(img, ANALYSIS_MAX_EDGE);
  const faces = await detectFaces(analysis.canvas);

  if (faces.length === 0) {
    return { error: "We couldn't find a face. Try a clearer, front-facing photo." };
  }
  if (faces.length > 1) {
    return { error: "More than one face was found. Use a photo with only you in it." };
  }

  const face = faces[0]!;
  if (Math.min(face.box.width, face.box.height) < MIN_FACE_PX) {
    return { error: "Your face is too small in this photo. Use a closer, front-facing shot." };
  }
  if (face.score < 0.75) {
    return { error: "That photo isn't clear enough. Try better lighting and look at the camera." };
  }

  // Three readings of one selfie: the original, its mirror, and the average of
  // the two. All near-frontal, so this is not angular coverage; that is
  // gathered later from the member's own confirmed matches. Holding all three
  // still helps, because each is differently wrong about lighting and framing.
  const flipped = await detectFaces(mirror(analysis.canvas));
  const references: number[][] = [face.descriptor];
  if (flipped.length === 1) {
    references.unshift(averageDescriptors([face.descriptor, flipped[0]!.descriptor]));
    references.push(flipped[0]!.descriptor);
  }

  try {
    const saved = await api.saveFaceProfile(references.slice(0, MAX_REFERENCES));
    // The crop is a convenience for the team, not part of enrolling, so a
    // failure here must not cost the member their face profile.
    await sendReferenceCrop(analysis.canvas, face.box).catch(() => undefined);
    return { error: null, references: saved.references };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not save your face profile" };
  }
}

/** Head and shoulders, roughly, around the detected box. */
const CROP_MARGIN = 0.6;
const CROP_EDGE = 320;

/**
 * Sends a small crop of the enrolled face for the operator console.
 *
 * The waiting list exists so the team can go and photograph whoever has not
 * been photographed yet, and a name and a number do not let anyone find a
 * person in a crowded room. This is the only photograph of a member the app
 * stores, it is a head-and-shoulders square rather than their selfie, and it
 * goes when they remove their face profile.
 */
async function sendReferenceCrop(
  source: HTMLCanvasElement,
  box: { x: number; y: number; width: number; height: number },
): Promise<void> {
  const margin = Math.max(box.width, box.height) * CROP_MARGIN;
  const size = Math.max(box.width, box.height) + margin * 2;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const canvas = document.createElement("canvas");
  canvas.width = CROP_EDGE;
  canvas.height = CROP_EDGE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, CROP_EDGE, CROP_EDGE);
  ctx.drawImage(source, cx - size / 2, cy - size / 2, size, size, 0, 0, CROP_EDGE, CROP_EDGE);

  const blob = await canvasToBlob(canvas, 0.8);
  await fetch("/media/face", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "image/jpeg" },
    body: blob,
  });
}
