const MODULE_URLS = [
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs",
  "https://unpkg.com/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs"
];

const WASM_URLS = [
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm",
  "https://unpkg.com/@mediapipe/tasks-vision@0.10.35/wasm"
];

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

export class FaceAlgorithm {
  constructor() {
    this.faceDetector = null;
    this.module = null;
    this.smoothBox = null;
    this.lastLatencyMs = 0;
    this.lastScore = 0;
  }

  async load(onStatus) {
    if (this.faceDetector) return;
    let lastError = null;

    for (const moduleUrl of MODULE_URLS) {
      try {
        onStatus?.(`Loading detector from ${new URL(moduleUrl).host}...`);
        const mod = await import(moduleUrl);
        this.module = mod;
        break;
      } catch (err) {
        lastError = err;
      }
    }

    if (!this.module) {
      throw new Error(`Detector module failed to load. ${lastError?.message || lastError || ""}`.trim());
    }

    const { FilesetResolver, FaceDetector } = this.module;
    let vision = null;
    for (const wasmUrl of WASM_URLS) {
      try {
        vision = await FilesetResolver.forVisionTasks(wasmUrl);
        break;
      } catch {
        // try next source
      }
    }

    if (!vision) {
      throw new Error("WASM runtime failed to load from all sources.");
    }

    this.faceDetector = await FaceDetector.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite",
        delegate: "GPU"
      },
      runningMode: "VIDEO",
      minDetectionConfidence: 0.6
    });
  }

  detect(video, tsMs) {
    if (!this.faceDetector) {
      return null;
    }

    const t0 = performance.now();
    const result = this.faceDetector.detectForVideo(video, tsMs);
    this.lastLatencyMs = performance.now() - t0;

    const faces = result.detections || [];
    if (!faces.length) {
      this.smoothBox = null;
      this.lastScore = 0;
      return null;
    }

    // Track the largest face to keep behavior stable in multi-face scenes.
    let best = faces[0];
    let bestArea = 0;
    for (const d of faces) {
      const b = d.boundingBox;
      const area = (b?.width || 0) * (b?.height || 0);
      if (area > bestArea) {
        best = d;
        bestArea = area;
      }
    }

    const box = best.boundingBox;
    if (!box) return null;
    this.lastScore = best.categories?.[0]?.score || 0;

    if (!this.smoothBox) {
      this.smoothBox = { x: box.originX, y: box.originY, w: box.width, h: box.height };
    } else {
      const t = 0.22;
      this.smoothBox.x = lerp(this.smoothBox.x, box.originX, t);
      this.smoothBox.y = lerp(this.smoothBox.y, box.originY, t);
      this.smoothBox.w = lerp(this.smoothBox.w, box.width, t);
      this.smoothBox.h = lerp(this.smoothBox.h, box.height, t);
    }

    return {
      x: clamp(this.smoothBox.x, 0, video.videoWidth),
      y: clamp(this.smoothBox.y, 0, video.videoHeight),
      w: clamp(this.smoothBox.w, 1, video.videoWidth),
      h: clamp(this.smoothBox.h, 1, video.videoHeight),
      score: this.lastScore,
      latencyMs: this.lastLatencyMs
    };
  }
}
