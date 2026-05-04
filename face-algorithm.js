const MODULE_URLS = [
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs",
  "https://unpkg.com/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs"
];
const WASM_URLS = [
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm",
  "https://unpkg.com/@mediapipe/tasks-vision@0.10.35/wasm"
];
const DETECTOR_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite";
const LANDMARKER_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task";

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}
function area(b) {
  return Math.max(0, b.w) * Math.max(0, b.h);
}
function iou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (!inter) return 0;
  return inter / (area(a) + area(b) - inter);
}
function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function expandBox(x, y, w, h, vw, vh, scale = 1.26) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const nw = w * scale;
  const nh = h * scale;
  const nx = clamp(cx - nw / 2, 0, vw);
  const ny = clamp(cy - nh / 2, 0, vh);
  return {
    x: nx,
    y: ny,
    w: clamp(nw, 1, vw - nx),
    h: clamp(nh, 1, vh - ny)
  };
}

export class FaceAlgorithm {
  constructor() {
    this.mode = "detector";
    this.detector = null;
    this.landmarker = null;
    this.tracks = new Map();
    this.seen = new Map();
    this.nextId = 1;
    this.minConfidence = 0.6;
    this.lastLatencyMs = 0;
    this.avgLatencyMs = 0;
    this.lastEventTs = 0;
  }

  async #loadVision(onStatus) {
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
    const { FilesetResolver } = mod;
    let vision = null;
    for (const wasmUrl of WASM_URLS) {
      try {
        vision = await FilesetResolver.forVisionTasks(wasmUrl);
        break;
      } catch {}
    }
    if (!vision) throw new Error("E_MODEL_LOAD: wasm failed");
    return { mod, vision };
  }

  async load(mode = "detector", onStatus) {
    this.mode = mode;
    const { mod, vision } = await this.#loadVision(onStatus);
    if (mode === "landmarker") {
      if (!this.landmarker) {
        const { FaceLandmarker } = mod;
        this.landmarker = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: LANDMARKER_MODEL_URL, delegate: "GPU" },
          runningMode: "VIDEO",
          numFaces: 2,
          outputFaceBlendshapes: true,
          minFaceDetectionConfidence: this.minConfidence
        });
      }
      return;
    }
    if (!this.detector) {
      const { FaceDetector } = mod;
      this.detector = await FaceDetector.createFromOptions(vision, {
        baseOptions: { modelAssetPath: DETECTOR_MODEL_URL, delegate: "GPU" },
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
    this.seen.clear();
    this.nextId = 1;
    this.lastLatencyMs = 0;
    this.avgLatencyMs = 0;
    this.lastEventTs = 0;
  }

  #associate(raw, options) {
    const { smoothFactor = 0.45, ttlMs = 260, mode = "single", lockId = null, iouThreshold = 0.15 } = options;
    const now = performance.now();
    const entries = [...this.tracks.entries()];
    const used = new Set();

    for (const d of raw) {
      let bestId = null;
      let best = 0;
      for (const [id, t] of entries) {
        if (used.has(id)) continue;
        const ov = iou(d, t);
        if (ov > best) {
          best = ov;
          bestId = id;
        }
      }
      if (bestId == null || best < iouThreshold) {
        bestId = this.nextId++;
        this.tracks.set(bestId, { ...d, id: bestId, scoreAvg: d.score });
      } else {
        const t = this.tracks.get(bestId);
        const move = Math.hypot((d.x + d.w / 2) - (t.x + t.w / 2), (d.y + d.h / 2) - (t.y + t.h / 2));
        const adaptive = clamp(smoothFactor + move / 240, 0.35, 0.78);
        t.x = lerp(t.x, d.x, adaptive);
        t.y = lerp(t.y, d.y, adaptive);
        t.w = lerp(t.w, d.w, adaptive);
        t.h = lerp(t.h, d.h, adaptive);
        t.score = d.score;
        t.scoreAvg = t.scoreAvg * 0.9 + d.score * 0.1;
        t.keypoints = d.keypoints || [];
        t.landmarks = d.landmarks || null;
      }
      used.add(bestId);
      this.seen.set(bestId, now);
    }

    for (const [id] of this.tracks) {
      if (now - (this.seen.get(id) || 0) > ttlMs) {
        this.tracks.delete(id);
        this.seen.delete(id);
      }
    }

    let faces = [...this.tracks.values()].sort((a, b) => area(b) - area(a));
    if (lockId != null) {
      const locked = faces.find((f) => f.id === lockId);
      faces = locked ? [locked] : [];
    } else if (mode === "single") {
      faces = faces.slice(0, 1);
    }
    return faces;
  }

  #eventsFromLandmarks(face) {
    const lm = face?.landmarks;
    if (!lm || lm.length < 309) return [];
    const leftEAR = dist(lm[159], lm[145]) / Math.max(1e-6, dist(lm[33], lm[133]));
    const rightEAR = dist(lm[386], lm[374]) / Math.max(1e-6, dist(lm[263], lm[362]));
    const mouthOpen = dist(lm[13], lm[14]) / Math.max(1e-6, dist(lm[78], lm[308]));
    const events = [];
    const now = performance.now();
    if (now - this.lastEventTs > 350) {
      if ((leftEAR + rightEAR) / 2 < 0.18) {
        events.push("blink");
        this.lastEventTs = now;
      } else if (mouthOpen > 0.34) {
        events.push("mouth_open");
        this.lastEventTs = now;
      }
    }
    return events;
  }

  detect(video, tsMs, options = {}) {
    const {
      minBoxSize = 10
    } = options;
    const t0 = performance.now();
    let raw = [];

    if (this.mode === "landmarker" && this.landmarker) {
      const res = this.landmarker.detectForVideo(video, tsMs);
      const vw = video.videoWidth || 1;
      const vh = video.videoHeight || 1;
      for (const landmarks of res.faceLandmarks || []) {
        let minX = 1, minY = 1, maxX = 0, maxY = 0;
        for (const p of landmarks) {
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.x > maxX) maxX = p.x;
          if (p.y > maxY) maxY = p.y;
        }
        let x = clamp(minX * vw, 0, vw);
        let y = clamp(minY * vh, 0, vh);
        let w = clamp((maxX - minX) * vw, 1, vw);
        let h = clamp((maxY - minY) * vh, 1, vh);
        ({ x, y, w, h } = expandBox(x, y, w, h, vw, vh));
        if (w < minBoxSize || h < minBoxSize) continue;
        raw.push({
          x, y, w, h,
          score: 0.9,
          landmarks: landmarks.map((p) => ({ x: p.x * vw, y: p.y * vh })),
          keypoints: []
        });
      }
    } else if (this.detector) {
      const res = this.detector.detectForVideo(video, tsMs);
      const vw = video.videoWidth || 1;
      const vh = video.videoHeight || 1;
      for (const det of res.detections || []) {
        const b = det.boundingBox;
        const score = det.categories?.[0]?.score || 0;
        if (!b || score < this.minConfidence || b.width < minBoxSize || b.height < minBoxSize) continue;
        raw.push({
          ...expandBox(
            clamp(b.originX, 0, vw),
            clamp(b.originY, 0, vh),
            clamp(b.width, 1, vw),
            clamp(b.height, 1, vh),
            vw,
            vh
          ),
          score,
          keypoints: (det.keypoints || []).map((p) => ({ x: p.x * vw, y: p.y * vh })),
          landmarks: null
        });
      }
    }

    this.lastLatencyMs = performance.now() - t0;
    this.avgLatencyMs = this.avgLatencyMs === 0 ? this.lastLatencyMs : this.avgLatencyMs * 0.9 + this.lastLatencyMs * 0.1;
    const faces = this.#associate(raw, options);
    const events = this.mode === "landmarker" ? this.#eventsFromLandmarks(faces[0]) : [];
    return { faces, events };
  }
}
