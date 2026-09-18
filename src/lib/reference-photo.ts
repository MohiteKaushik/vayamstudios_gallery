import { ANALYSIS_MAX_EDGE, MIN_FACE_PX, averageDescriptors, detectFaces } from "./face";
import { downscale, fileToImage, mirror } from "./images";

// Temporary export reference only. Neither the original nor a crop is uploaded.
export async function referenceFromPhoto(file: File): Promise<number[][]> {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
  if (file.size > 25 * 1024 * 1024) throw new Error("Choose a photo smaller than 25 MB.");
  const image = await fileToImage(file);
  const { canvas } = downscale(image, ANALYSIS_MAX_EDGE);
  const faces = await detectFaces(canvas);
  if (!faces.length) throw new Error("No face found. Choose a clear, front-facing photo.");
  if (faces.length !== 1) throw new Error("Multiple faces found. Crop the photo to just the desired person.");
  const face = faces[0]!;
  if (face.score < 0.75 || Math.min(face.box.width, face.box.height) < MIN_FACE_PX) {
    throw new Error("The face is too small or unclear. Choose a closer photo.");
  }
  const flipped = await detectFaces(mirror(canvas));
  return flipped.length === 1
    ? [averageDescriptors([face.descriptor, flipped[0]!.descriptor]), face.descriptor, flipped[0]!.descriptor]
    : [face.descriptor];
}
