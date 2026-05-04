const MODULE_URLS = [
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs",
  "https://unpkg.com/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs"
];
const WASM_URLS = [
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm",
  "https://unpkg.com/@mediapipe/tasks-vision@0.10.35/wasm"
];
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite";

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}
function boxArea(b) {
  return Math.max(0, b.w) * Math.max(0, b.h);
}
function iou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter <= 0) return 0;
  const union = boxArea(a) + boxArea(b) - inter;
  return union <= 0 ? 0 : inter / union;
}

export class FaceAlgorithm {
  constructor() {
    this.detector = null;
    this.tracks = new Map();
    this.lastSeenTs = new Map();
    this.nextId = 1;
    this.minConfidence = 0.6;
    this.lastLatencyMs = 0;
    this.avgLatencyMs = 0;
  }

  async load(onStatus) {
    if (this.detector) return;
    let mod = null;
    let lastErr = null;
    for (const url of MODULE_URLS) {
      try {
        onStatus?.(`Loading engine: ${new URL(url).host}`);
        mod = await import(url);
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!mod) throw new Error(`E_MODEL_LOAD: ${lastErr?.message || lastErr || "module failed"}`);

    const { FilesetResolver, FaceDetector } = mod;
    let vision = null;
    for (const wasmUrl of WASM_URLS) {
      try {
        vision = await FilesetResolver.forVisionTasks(wasmUrl);
        break;
      } catch {}
    }
    if (!vision) throw new Error("E_MODEL_LOAD: wasm failed");

    try {
      this.detector = await FaceDetector.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
        runningMode: "VIDEO",
        minDetectionConfidence: this.minConfidence
      });
    } catch {
      this.detector = await FaceDetector.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
        runningMode: "VIDEO",
        minDetectionConfidence: this.minConfidence
      });
    }
  }

  setMinConfidence(value) {
    this.minConfidence = clamp(value, 0.2, 0.95);
  }

  reset() {
    this.tracks.clear();
    this.lastSeenTs.clear();
    this.nextId = 1;
    this.lastLatencyMs = 0;
    this.avgLatencyMs = 0;
  }

  detect(video, tsMs, options = {}) {
    if (!this.detector) return [];
    const {
      smoothFactor = 0.22,
      ttlMs = 300,
      minBoxSize = 20,
      mode = "single",
      lockId = null,
      iouThreshold = 0.2
    } = options;

    const t0 = performance.now();
    const result = this.detector.detectForVideo(video, tsMs);
    this.lastLatencyMs = performance.now() - t0;
    this.avgLatencyMs = this.avgLatencyMs === 0 ? this.lastLatencyMs : this.avgLatencyMs * 0.9 + this.lastLatencyMs * 0.1;

    const vw = video.videoWidth || 1;
    const vh = video.videoHeight || 1;
    const now = performance.now();

    const detections = [];
    for (const det of result.detections || []) {
      const b = det.boundingBox;
      const score = det.categories?.[0]?.score || 0;
      if (!b || score < this.minConfidence || b.width < minBoxSize || b.height < minBoxSize) continue;
      detections.push({
        x: clamp(b.originX, 0, vw),
        y: clamp(b.originY, 0, vh),
        w: clamp(b.width, 1, vw),
        h: clamp(b.height, 1, vh),
        score,
        keypoints: (det.keypoints || []).map((p) => ({ x: p.x * vw, y: p.y * vh }))
      });
    }

    // IoU-based association (more stable than nearest-center in multi-face scenes).
    const trackEntries = [...this.tracks.entries()];
    const usedTrack = new Set();
    for (const d of detections) {
      let bestId = null;
      let bestIou = 0;
      for (const [id, t] of trackEntries) {
        if (usedTrack.has(id)) continue;
        const ov = iou(d, t);
        if (ov > bestIou) {
          bestIou = ov;
          bestId = id;
        }
      }

      if (bestId == null || bestIou < iouThreshold) {
        bestId = this.nextId++;
        this.tracks.set(bestId, { ...d, id: bestId, scoreAvg: d.score });
      } else {
        const t = this.tracks.get(bestId);
        // Dynamic smoothing: fast movement => lower smoothing, stable => higher smoothing.
        const movement = Math.hypot((d.x + d.w / 2) - (t.x + t.w / 2), (d.y + d.h / 2) - (t.y + t.h / 2));
        const adaptive = clamp(smoothFactor - movement / 400, 0.12, 0.35);
        t.x = lerp(t.x, d.x, adaptive);
        t.y = lerp(t.y, d.y, adaptive);
        t.w = lerp(t.w, d.w, adaptive);
        t.h = lerp(t.h, d.h, adaptive);
        t.score = d.score;
        t.scoreAvg = t.scoreAvg * 0.9 + d.score * 0.1;
        t.keypoints = d.keypoints;
      }
      usedTrack.add(bestId);
      this.lastSeenTs.set(bestId, now);
    }

    for (const [id] of this.tracks) {
      const seen = this.lastSeenTs.get(id) || 0;
      if (now - seen > ttlMs) {
        this.tracks.delete(id);
        this.lastSeenTs.delete(id);
      }
    }

    let faces = [...this.tracks.values()].sort((a, b) => boxArea(b) - boxArea(a));
    if (lockId != null) {
      const locked = faces.find((f) => f.id === lockId);
      faces = locked ? [locked] : [];
    } else if (mode === "single") {
      faces = faces.slice(0, 1);
    }
    return faces;
  }
}
