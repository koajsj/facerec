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
  return inter / (boxArea(a) + boxArea(b) - inter);
}

function expandBox(x, y, w, h, vw, vh, scale = 1.38) {
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

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export class FaceAlgorithm {
  constructor() {
    this.mode = "detector";
    this.detector = null;
    this.landmarker = null;
    this.tracks = new Map();
    this.seen = new Map();
    this.nextId = 1;
    this.minConfidence = 0.45;
    this.lastLatencyMs = 0;
    this.avgLatencyMs = 0;
    this.lastEventTs = 0;
  }

  async #loadVision(onStatus) {
    let mod = null;
    let lastError = null;
    for (const url of MODULE_URLS) {
      try {
        onStatus?.(`加载引擎: ${new URL(url).host}`);
        mod = await import(url);
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!mod) throw new Error(`E_MODEL_LOAD: ${lastError?.message || lastError || "module failed"}`);

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
          numFaces: 1,
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

  setMinConfidence(v) {
    this.minConfidence = clamp(v, 0.2, 0.95);
  }

  reset() {
    this.tracks.clear();
    this.seen.clear();
    this.nextId = 1;
    this.lastLatencyMs = 0;
    this.avgLatencyMs = 0;
    this.lastEventTs = 0;
  }

  #track(rawFaces, options) {
    const { smoothFactor = 0.45, ttlMs = 260, iouThreshold = 0.15 } = options;
    const now = performance.now();
    const entries = [...this.tracks.entries()];
    const used = new Set();

    for (const f of rawFaces) {
      let bestId = null;
      let bestIou = 0;
      for (const [id, t] of entries) {
        if (used.has(id)) continue;
        const ov = iou(f, t);
        if (ov > bestIou) {
          bestIou = ov;
          bestId = id;
        }
      }

      if (bestId == null || bestIou < iouThreshold) {
        bestId = this.nextId++;
        this.tracks.set(bestId, { ...f, id: bestId, scoreAvg: f.score });
      } else {
        const t = this.tracks.get(bestId);
        const movement = Math.hypot((f.x + f.w / 2) - (t.x + t.w / 2), (f.y + f.h / 2) - (t.y + t.h / 2));
        const alpha = clamp(smoothFactor + movement / 240, 0.35, 0.82);
        t.x = lerp(t.x, f.x, alpha);
        t.y = lerp(t.y, f.y, alpha);
        t.w = lerp(t.w, f.w, alpha);
        t.h = lerp(t.h, f.h, alpha);
        t.score = f.score;
        t.scoreAvg = t.scoreAvg * 0.75 + f.score * 0.25;
        t.landmarks = f.landmarks || null;
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

    return [...this.tracks.values()].sort((a, b) => boxArea(b) - boxArea(a)).slice(0, 1);
  }

  #extractEvents(face) {
    const lm = face?.landmarks;
    if (!lm || lm.length < 309) return [];

    const leftEAR = dist(lm[159], lm[145]) / Math.max(1e-6, dist(lm[33], lm[133]));
    const rightEAR = dist(lm[386], lm[374]) / Math.max(1e-6, dist(lm[263], lm[362]));
    const mouthOpen = dist(lm[13], lm[14]) / Math.max(1e-6, dist(lm[78], lm[308]));

    const now = performance.now();
    if (now - this.lastEventTs <= 350) return [];
    if ((leftEAR + rightEAR) / 2 < 0.18) {
      this.lastEventTs = now;
      return ["blink"];
    }
    if (mouthOpen > 0.34) {
      this.lastEventTs = now;
      return ["mouth_open"];
    }
    return [];
  }

  detect(video, tsMs, options = {}) {
    const { minBoxSize = 8 } = options;
    const vw = video.videoWidth || 1;
    const vh = video.videoHeight || 1;
    const t0 = performance.now();
    const raw = [];

    if (this.mode === "landmarker" && this.landmarker) {
      const res = this.landmarker.detectForVideo(video, tsMs);
      const blendshapes = res.faceBlendshapes || [];
      for (let i = 0; i < (res.faceLandmarks || []).length; i += 1) {
        const landmarks = res.faceLandmarks[i];
        let minX = 1, minY = 1, maxX = 0, maxY = 0;
        for (const p of landmarks) {
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.x > maxX) maxX = p.x;
          if (p.y > maxY) maxY = p.y;
        }
        let x = minX * vw;
        let y = minY * vh;
        let w = (maxX - minX) * vw;
        let h = (maxY - minY) * vh;
        ({ x, y, w, h } = expandBox(x, y, w, h, vw, vh));
        if (w < minBoxSize || h < minBoxSize) continue;
        const categories = blendshapes[i]?.categories || [];
        const presence = categories.find((c) => (c.categoryName || "").toLowerCase().includes("presence"))?.score;
        raw.push({
          x,
          y,
          w,
          h,
          score: typeof presence === "number" ? clamp(presence, 0, 1) : 0.88,
          landmarks: landmarks.map((p) => ({ x: p.x * vw, y: p.y * vh }))
        });
      }
    } else if (this.detector) {
      const res = this.detector.detectForVideo(video, tsMs);
      for (const det of res.detections || []) {
        const b = det.boundingBox;
        const score = det.categories?.[0]?.score || 0;
        if (!b || score < this.minConfidence || b.width < minBoxSize || b.height < minBoxSize) continue;
        const expanded = expandBox(b.originX, b.originY, b.width, b.height, vw, vh);
        raw.push({ ...expanded, score, landmarks: null });
      }
    }

    this.lastLatencyMs = performance.now() - t0;
    this.avgLatencyMs = this.avgLatencyMs === 0 ? this.lastLatencyMs : this.avgLatencyMs * 0.9 + this.lastLatencyMs * 0.1;

    const faces = this.#track(raw, options);
    const events = this.mode === "landmarker" ? this.#extractEvents(faces[0]) : [];
    return { faces, events };
  }
}
