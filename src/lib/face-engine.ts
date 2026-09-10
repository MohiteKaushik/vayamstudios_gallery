/**
 * The face engine, in the browser.
 *
 * Loads the two InsightFace models through onnxruntime-web and drives them with
 * the arithmetic in insightface.ts. Everything here is the part that needs a
 * canvas or an inference session; the maths lives next door so that the offline
 * measurements and this file cannot drift apart.
 *
 * WHY THIS REPLACED face-api.js
 *
 * face-api's descriptor is a ResNet-34 from 2017. It is fine at telling two
 * front-facing photographs apart and poor at everything else, and measuring it
 * on the studio's own collections showed how poor: two different guests sat
 * 0.66 apart, a stranger reached a member's reference at 0.349, and there was
 * no threshold with a stranger on one side and a turned head on the other.
 *
 * The same collections through SCRFD and ArcFace:
 *
 *   collection    same person up to    nearest different person
 *   demo                      0.169                      0.849
 *   event                     0.385                      0.598
 *   portraits                 0.615    none within the 23 nearest
 *
 * A gap, at last, and wide enough to put a threshold in. Profile shots that
 * face-api put beyond 0.8, further away than strangers, now come back at 0.49.
 *
 * WHAT IT COSTS
 *
 * About 30 MB on a first visit: 14 MB of runtime and 16 MB of models, served
 * from this Worker's own static assets and cached by the browser afterwards.
 * Nothing is fetched from anyone else, and no photograph leaves the device.
 */

// The WASM-only entry point, not the default one.
//
// The default entry references every backend it can build, including WebGPU,
// and a bundler follows those references: the client build carried a 27.8 MB
// jsep binary that nothing here ever loaded, because wasmPaths is set below and
// only the plain SIMD build is served. This entry references one runtime.
import * as ort from "onnxruntime-web/wasm";
import {
  ARCFACE_SIZE,
  SCRFD_INPUT,
  alignmentFor,
  arcfaceTensor,
  decodeScrfd,
  l2normalise,
  nonMaxSuppression,
  rescale,
  scrfdTensor,
  warpToArcface,
  type Detection,
  type Point,
} from "./insightface.ts";

/**
 * Where the models are served from.
 *
 * Static assets on this Worker, which are free and unmetered, rather than a
 * public CDN. The app used to pull face-api's weights from jsdelivr, and that
 * is a third party who can rate-limit, move a path or go down in the middle of
 * an event, for a file that never changes.
 */
const DETECTOR_URL = "/models/scrfd-500m.onnx";
const RECOGNISER_URL = "/models/arcface-w600k-mbf.onnx";

/** Detector confidence floor. Below the usual 0.5, because a turned or shadowed
 *  head scores lower than a posed one and those are the ones worth finding. */
export const DETECT_MIN_CONFIDENCE = 0.4;

/** Boxes overlapping more than this within one pass are the same face. */
const NMS_IOU = 0.4;

export type EngineProgress = (loaded: number, total: number) => void;

type Engine = {
  detector: ort.InferenceSession;
  recogniser: ort.InferenceSession;
  detectorInput: string;
  detectorOutputs: readonly string[];
  recogniserInput: string;
  recogniserOutput: string;
};

let enginePromise: Promise<Engine> | null = null;
const listeners = new Set<EngineProgress>();
let bytesLoaded = 0;
let bytesTotal = 0;

/** Called while the models download, so a member sees something happening. */
export function onEngineProgress(fn: EngineProgress): () => void {
  listeners.add(fn);
  if (bytesTotal > 0) fn(bytesLoaded, bytesTotal);
  return () => listeners.delete(fn);
}

function report(loaded: number, total: number) {
  bytesLoaded = loaded;
  bytesTotal = total;
  for (const fn of listeners) fn(loaded, total);
}

/**
 * Fetches a model, reporting progress.
 *
 * Progress matters more than it looks. This is 16 MB over whatever connection
 * someone has at an event, and a button that sits there saying nothing for
 * twenty seconds is a button people press again, and again.
 */
async function fetchModel(url: string, onChunk: (bytes: number) => void): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load the face model (${res.status})`);
  if (!res.body) return res.arrayBuffer();

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    onChunk(value.length);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out.buffer;
}

export function loadEngine(): Promise<Engine> {
  if (!enginePromise) {
    enginePromise = (async () => {
      // The runtime binary is not named here. The bundler emits it beside this
      // module and rewrites the reference, so it is served from this Worker's own
      // assets with a content hash. Setting wasmPaths by hand put a second copy in
      // public/ and shipped both.
      // One worker per core, capped. More threads than a phone has cores makes
      // it slower, not faster, and the cap keeps a bulk index from taking the
      // whole machine while the operator is still using it.
      ort.env.wasm.numThreads = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2));
      ort.env.logLevel = "error";

      // Known sizes, so the bar means something before the first byte lands.
      const expected = 2_524_817 + 13_616_099;
      let loaded = 0;
      const onChunk = (n: number) => {
        loaded += n;
        report(Math.min(loaded, expected), expected);
      };
      report(0, expected);

      const [detBytes, recBytes] = await Promise.all([
        fetchModel(DETECTOR_URL, onChunk),
        fetchModel(RECOGNISER_URL, onChunk),
      ]);

      const options: ort.InferenceSession.SessionOptions = {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      };
      const [detector, recogniser] = await Promise.all([
        ort.InferenceSession.create(detBytes, options),
        ort.InferenceSession.create(recBytes, options),
      ]);
      report(expected, expected);

      return {
        detector,
        recogniser,
        detectorInput: detector.inputNames[0]!,
        detectorOutputs: detector.outputNames,
        recogniserInput: recogniser.inputNames[0]!,
        recogniserOutput: recogniser.outputNames[0]!,
      };
    })().catch((e) => {
      enginePromise = null;
      throw e;
    });
  }
  return enginePromise!;
}

/* -------------------------------------------------------------------------- */
/*                            Canvas to raw pixels                            */
/* -------------------------------------------------------------------------- */

function contextFor(width: number, height: number): CanvasRenderingContext2D {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("This browser would not give us a canvas to work on");
  return ctx;
}

/** Drops the alpha channel: both models want three tightly packed channels. */
function toRgb(data: Uint8ClampedArray, pixels: number): Uint8Array {
  const out = new Uint8Array(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    out[i * 3] = data[i * 4]!;
    out[i * 3 + 1] = data[i * 4 + 1]!;
    out[i * 3 + 2] = data[i * 4 + 2]!;
  }
  return out;
}

export type Source = HTMLImageElement | HTMLCanvasElement | ImageBitmap;

function sizeOf(source: Source): { width: number; height: number } {
  if (source instanceof HTMLImageElement) {
    return { width: source.naturalWidth || source.width, height: source.naturalHeight || source.height };
  }
  return { width: source.width, height: source.height };
}

/* -------------------------------------------------------------------------- */
/*                                 Detection                                  */
/* -------------------------------------------------------------------------- */

export type DetectedFace = {
  /** 512 numbers, unit length. Compared with cosine distance, never Euclidean. */
  descriptor: number[];
  box: { x: number; y: number; width: number; height: number };
  score: number;
  landmarks: Point[];
  /** Long edge of the crop this face was read from. Higher means a better read. */
  readAtPx?: number;
};

/**
 * Finds every face in one image and embeds each of them.
 *
 * The detector sees a 640x640 letterbox of the whole frame, which is why a
 * 6000 pixel group shot needs the tiled passes in face.ts on top of this: at
 * that scale a guest standing at the back is a dozen pixels across and no
 * detector will find them. The embedding, though, is always taken from the
 * original pixels rather than from the shrunken copy, so a face that is found
 * is described at full resolution.
 */
export async function detectFaces(
  source: Source,
  minConfidence = DETECT_MIN_CONFIDENCE,
): Promise<DetectedFace[]> {
  const engine = await loadEngine();
  const { width, height } = sizeOf(source);
  if (width === 0 || height === 0) return [];

  const scale = Math.min(SCRFD_INPUT / width, SCRFD_INPUT / height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  // The letterbox. Grey rather than black, matching the value the detector's
  // normalisation maps to zero.
  const boxed = contextFor(SCRFD_INPUT, SCRFD_INPUT);
  boxed.fillStyle = "rgb(128,128,128)";
  boxed.fillRect(0, 0, SCRFD_INPUT, SCRFD_INPUT);
  boxed.drawImage(source as CanvasImageSource, 0, 0, w, h);
  const boxedRgb = toRgb(
    boxed.getImageData(0, 0, SCRFD_INPUT, SCRFD_INPUT).data,
    SCRFD_INPUT * SCRFD_INPUT,
  );

  const outputs = await engine.detector.run({
    [engine.detectorInput]: new ort.Tensor(
      "float32",
      scrfdTensor(boxedRgb, SCRFD_INPUT, SCRFD_INPUT),
      [1, 3, SCRFD_INPUT, SCRFD_INPUT],
    ),
  });

  const at = (i: number) => outputs[engine.detectorOutputs[i]!]!.data as Float32Array;
  const found = decodeScrfd(
    {
      scores: [at(0), at(1), at(2)],
      boxes: [at(3), at(4), at(5)],
      keypoints: [at(6), at(7), at(8)],
    },
    minConfidence,
  );
  const detections: Detection[] = rescale(nonMaxSuppression(found, NMS_IOU), scale);
  if (detections.length === 0) return [];

  // Full-resolution pixels, once, for every crop taken below.
  const full = contextFor(width, height);
  full.drawImage(source as CanvasImageSource, 0, 0);
  const fullRgb = toRgb(full.getImageData(0, 0, width, height).data, width * height);

  const faces: DetectedFace[] = [];
  for (const d of detections) {
    const crop = warpToArcface(fullRgb, width, height, alignmentFor(d.landmarks));
    const result = await engine.recogniser.run({
      [engine.recogniserInput]: new ort.Tensor("float32", arcfaceTensor(crop), [
        1, 3, ARCFACE_SIZE, ARCFACE_SIZE,
      ]),
    });
    faces.push({
      descriptor: l2normalise(result[engine.recogniserOutput]!.data as Float32Array),
      box: {
        x: Math.round(d.box.x),
        y: Math.round(d.box.y),
        width: Math.round(d.box.width),
        height: Math.round(d.box.height),
      },
      score: d.score,
      landmarks: d.landmarks,
      readAtPx: Math.max(width, height),
    });
  }
  return faces;
}
