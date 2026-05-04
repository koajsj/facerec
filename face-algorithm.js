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

export class FaceAlgorithm {
  constructor() {
    this.detector = null;
    this.rawFaces = [];
    this.smoothFaces = new Map();
    this.nextId = 1;
    this.lastLatencyMs = 0;
    this.avgLatencyMs = 0;
    this.minConfidence = 0.6;
    this.lastSeenTs = new Map();
  }

  async load(onStatus) {
    if (this.detector) return;
    let mod = null;
    let lastErr = null;
    for (const url of MODULE_URLS) {
      try {
        onStatus?.(`加载引擎: ${new URL(url).host}`);
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
      } catch {
        // fallback source
      }
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
    this.rawFaces = [];
    this.smoothFaces.clear();
    this.lastSeenTs.clear();
    this.nextId = 1;
    this.lastLatencyMs = 0;
    this.avgLatencyMs = 0;
  }

  detect(video, tsMs, options) {
    if (!this.detector) return [];
    const { smoothFactor = 0.22, ttlMs = 280, mode = "single", minBoxSize = 20, lockId = null } = options;

    const t0 = performance.now();
    const result = this.detector.detectForVideo(video, tsMs);
    this.lastLatencyMs = performance.now() - t0;
    this.avgLatencyMs = this.avgLatencyMs === 0 ? this.lastLatencyMs : this.avgLatencyMs * 0.9 + this.lastLatencyMs * 0.1;

    const vw = video.videoWidth || 1;
    const vh = video.videoHeight || 1;
    const now = performance.now();
    const detections = result.detections || [];

    const current = [];
    for (const det of detections) {
      const b = det.boundingBox;
      if (!b) continue;
      const score = det.categories?.[0]?.score || 0;
      if (score < this.minConfidence) continue;
      if (b.width < minBoxSize || b.height < minBoxSize) continue;
      current.push({
        x: clamp(b.originX, 0, vw),
        y: clamp(b.originY, 0, vh),
        w: clamp(b.width, 1, vw),
        h: clamp(b.height, 1, vh),
        score,
        keypoints: (det.keypoints || []).map((p) => ({ x: p.x * vw, y: p.y * vh }))
      });
    }

    // Greedy association by nearest center.
    const smoothEntries = [...this.smoothFaces.entries()];
    const used = new Set();
    for (const face of current) {
      let bestId = null;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const [id, s] of smoothEntries) {
        if (used.has(id)) continue;
        const dx = s.x + s.w / 2 - (face.x + face.w / 2);
        const dy = s.y + s.h / 2 - (face.y + face.h / 2);
        const dist = dx * dx + dy * dy;
        if (dist < bestDist) {
          bestDist = dist;
          bestId = id;
        }
      }
      if (bestId == null) {
        bestId = this.nextId++;
        this.smoothFaces.set(bestId, { ...face, id: bestId, scoreAvg: face.score });
      } else {
        const s = this.smoothFaces.get(bestId);
        s.x = lerp(s.x, face.x, smoothFactor);
        s.y = lerp(s.y, face.y, smoothFactor);
        s.w = lerp(s.w, face.w, smoothFactor);
        s.h = lerp(s.h, face.h, smoothFactor);
        s.score = face.score;
        s.scoreAvg = s.scoreAvg * 0.9 + face.score * 0.1;
        s.keypoints = face.keypoints;
      }
      used.add(bestId);
      this.lastSeenTs.set(bestId, now);
    }

    // TTL retention to reduce blinking.
    for (const [id] of this.smoothFaces) {
      const seen = this.lastSeenTs.get(id) || 0;
      if (now - seen > ttlMs) {
        this.smoothFaces.delete(id);
        this.lastSeenTs.delete(id);
      }
    }

    let faces = [...this.smoothFaces.values()].sort((a, b) => boxArea(b) - boxArea(a));
    if (lockId != null) {
      const locked = faces.find((f) => f.id === lockId);
      if (locked) faces = [locked];
    } else if (mode === "single") {
      faces = faces.slice(0, 1);
    }
    return faces;
  }
}
