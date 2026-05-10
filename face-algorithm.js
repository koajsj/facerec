const VISION_VERSION = "0.10.35";

const MODULE_URLS = [
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/vision_bundle.mjs`,
  `https://unpkg.com/@mediapipe/tasks-vision@${VISION_VERSION}/vision_bundle.mjs`
];

const WASM_URLS = [
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/wasm`,
  `https://unpkg.com/@mediapipe/tasks-vision@${VISION_VERSION}/wasm`
];

const LANDMARKER_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function boxArea(box) {
  return Math.max(0, box.w) * Math.max(0, box.h);
}

function center(box) {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

function iou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter <= 0) return 0;
  return inter / Math.max(1, boxArea(a) + boxArea(b) - inter);
}

function expandBox(x, y, w, h, vw, vh) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const faceRatio = (w * h) / Math.max(1, vw * vh);
  const scale = clamp(1.42 - faceRatio * 0.22, 1.28, 1.5);
  const verticalBias = h * 0.03;
  const nw = w * scale;
  const nh = h * (scale + 0.04);
  const nx = clamp(cx - nw / 2, 0, vw);
  const ny = clamp(cy - nh / 2 - verticalBias, 0, vh);
  return {
    x: nx,
    y: ny,
    w: clamp(nw, 1, vw - nx),
    h: clamp(nh, 1, vh - ny)
  };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function estimateFaceScore(bounds, vw, vh) {
  const { minX, minY, maxX, maxY } = bounds;
  const width = Math.max(0, maxX - minX);
  const height = Math.max(0, maxY - minY);
  const areaRatio = (width * height) / Math.max(1, vw * vh);
  const cx = minX + width / 2;
  const cy = minY + height / 2;
  const centerGap = Math.hypot(cx / vw - 0.5, cy / vh - 0.5);
  const edgeMargin = Math.min(minX, minY, vw - maxX, vh - maxY) / Math.max(1, Math.min(vw, vh));
  const aspect = height / Math.max(1, width);

  const sizeScore = Math.min(clamp((areaRatio - 0.012) / 0.09, 0, 1), clamp((0.62 - areaRatio) / 0.3, 0, 1));
  const centerScore = 1 - clamp(centerGap / 0.58, 0, 1);
  const edgeScore = clamp((edgeMargin + 0.04) / 0.12, 0, 1);
  const aspectScore = 1 - clamp(Math.abs(aspect - 1.28) / 0.9, 0, 1);

  return clamp(0.28 + sizeScore * 0.26 + centerScore * 0.18 + edgeScore * 0.2 + aspectScore * 0.16, 0.24, 0.99);
}

function blendBox(target, raw, alpha) {
  target.x = lerp(target.x, raw.x, alpha);
  target.y = lerp(target.y, raw.y, alpha);
  target.w = lerp(target.w, raw.w, alpha);
  target.h = lerp(target.h, raw.h, alpha);
}

export class FaceAlgorithm {
  constructor() {
    this.landmarker = null;
    this.tracks = new Map();
    this.nextId = 1;
    this.minConfidence = 0.42;
    this.lastLatencyMs = 0;
    this.avgLatencyMs = 0;
    this.lastEventTs = 0;
  }

  async #loadVision(onStatus) {
    let mod = null;
    let lastError = null;
    for (const url of MODULE_URLS) {
      try {
        onStatus?.(`加载引擎 ${new URL(url).host}`);
        mod = await import(url);
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!mod) throw new Error(`模型加载失败：${lastError?.message || lastError || "module failed"}`);

    const { FilesetResolver } = mod;
    let vision = null;
    for (const wasmUrl of WASM_URLS) {
      try {
        vision = await FilesetResolver.forVisionTasks(wasmUrl);
        break;
      } catch {}
    }
    if (!vision) throw new Error("WASM 加载失败");
    return { mod, vision };
  }

  async load(onStatus) {
    if (this.landmarker) return;
    const { mod, vision } = await this.#loadVision(onStatus);
    const { FaceLandmarker } = mod;
    this.landmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: LANDMARKER_MODEL_URL,
        delegate: "GPU"
      },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: false,
      minFaceDetectionConfidence: this.minConfidence,
      minFacePresenceConfidence: Math.max(0.35, this.minConfidence - 0.08),
      minTrackingConfidence: 0.35
    });
  }

  setMinConfidence(value) {
    this.minConfidence = clamp(value, 0.25, 0.85);
  }

  reset() {
    this.tracks.clear();
    this.nextId = 1;
    this.lastLatencyMs = 0;
    this.avgLatencyMs = 0;
    this.lastEventTs = 0;
  }

  #matchTrack(rawFace, entries, used, iouThreshold) {
    let bestId = null;
    let bestScore = -Infinity;
    const rawCenter = center(rawFace);

    for (const [id, track] of entries) {
      if (used.has(id)) continue;
      const overlap = iou(rawFace, track);
      const trackCenter = center(track);
      const centerGap = distance(rawCenter, trackCenter);
      const size = Math.max(rawFace.w, rawFace.h, track.w, track.h, 1);
      const proximity = 1 - clamp(centerGap / (size * 1.1), 0, 1);
      const score = overlap * 0.7 + proximity * 0.3;
      if (score > bestScore) {
        bestScore = score;
        bestId = id;
      }
    }

    return bestScore >= iouThreshold ? bestId : null;
  }

  #track(rawFaces, options) {
    const { followSpeed = 0.78, ttlMs = 300, iouThreshold = 0.11 } = options;
    const now = performance.now();
    const entries = [...this.tracks.entries()];
    const used = new Set();

    for (const raw of rawFaces) {
      let id = this.#matchTrack(raw, entries, used, iouThreshold);
      if (id == null) {
        id = this.nextId++;
        this.tracks.set(id, {
          ...raw,
          id,
          vx: 0,
          vy: 0,
          vw: 0,
          vh: 0,
          jitter: 0,
          scoreAvg: raw.score,
          lastSeen: now
        });
      } else {
        const track = this.tracks.get(id);
        const old = { x: track.x, y: track.y, w: track.w, h: track.h };
        const oldCenter = center(track);
        const rawCenter = center(raw);
        const movement = distance(rawCenter, oldCenter);
        const size = Math.max(track.w, track.h, 1);
        const movementRatio = clamp(movement / size, 0, 1.4);
        const confidenceBoost = clamp(raw.score, 0.35, 1) * 0.14;
        const alpha = clamp(followSpeed * 0.56 + movementRatio * 0.42 + confidenceBoost, 0.42, 0.94);

        blendBox(track, raw, alpha);
        track.vx = track.x - old.x;
        track.vy = track.y - old.y;
        track.vw = track.w - old.w;
        track.vh = track.h - old.h;
        track.jitter = movement;
        track.score = clamp(raw.score - movementRatio * 0.12, 0.2, 1);
        track.scoreAvg = track.scoreAvg * 0.7 + track.score * 0.3;
        track.landmarks = raw.landmarks;
        track.lastSeen = now;

        const predict = clamp(movementRatio * 0.22, 0, 0.18);
        track.x += track.vx * predict;
        track.y += track.vy * predict;
        track.w += track.vw * predict * 0.6;
        track.h += track.vh * predict * 0.6;
      }

      used.add(id);
    }

    for (const [id, track] of this.tracks) {
      if (now - (track.lastSeen || 0) > ttlMs) {
        this.tracks.delete(id);
      }
    }

    return [...this.tracks.values()].sort((a, b) => boxArea(b) - boxArea(a)).slice(0, 1);
  }

  #extractEvents(face) {
    const lm = face?.landmarks;
    if (!lm || lm.length < 386) return [];

    const leftEAR = distance(lm[159], lm[145]) / Math.max(1e-6, distance(lm[33], lm[133]));
    const rightEAR = distance(lm[386], lm[374]) / Math.max(1e-6, distance(lm[263], lm[362]));
    const mouthOpen = distance(lm[13], lm[14]) / Math.max(1e-6, distance(lm[78], lm[308]));
    const nose = lm[1];
    const left = lm[234];
    const right = lm[454];
    const faceWidth = Math.max(1e-6, distance(left, right));
    const yawOffset = Math.abs((nose.x - (left.x + right.x) / 2) / faceWidth);

    const now = performance.now();
    if (now - this.lastEventTs <= 320) return [];

    if ((leftEAR + rightEAR) / 2 < 0.18) {
      this.lastEventTs = now;
      return ["blink"];
    }
    if (mouthOpen > 0.34) {
      this.lastEventTs = now;
      return ["mouth_open"];
    }
    if (yawOffset > 0.14) {
      this.lastEventTs = now;
      return ["turn"];
    }
    return [];
  }

  detect(video, timestampMs, options = {}) {
    const { minBoxSize = 7 } = options;
    const vw = video.videoWidth || 1;
    const vh = video.videoHeight || 1;
    const start = performance.now();
    const rawFaces = [];

    if (this.landmarker) {
      const result = this.landmarker.detectForVideo(video, timestampMs);

      for (let i = 0; i < (result.faceLandmarks || []).length; i += 1) {
        const landmarks = result.faceLandmarks[i];
        let minX = 1;
        let minY = 1;
        let maxX = 0;
        let maxY = 0;

        for (const point of landmarks) {
          minX = Math.min(minX, point.x);
          minY = Math.min(minY, point.y);
          maxX = Math.max(maxX, point.x);
          maxY = Math.max(maxY, point.y);
        }

        let x = minX * vw;
        let y = minY * vh;
        let w = (maxX - minX) * vw;
        let h = (maxY - minY) * vh;
        const score = estimateFaceScore({ minX: x, minY: y, maxX: x + w, maxY: y + h }, vw, vh);
        ({ x, y, w, h } = expandBox(x, y, w, h, vw, vh));
        if (w < minBoxSize || h < minBoxSize) continue;

        if (score < this.minConfidence - 0.12) continue;

        rawFaces.push({
          x,
          y,
          w,
          h,
          score,
          landmarks: landmarks.map((point) => ({ x: point.x * vw, y: point.y * vh }))
        });
      }
    }

    this.lastLatencyMs = performance.now() - start;
    this.avgLatencyMs = this.avgLatencyMs === 0 ? this.lastLatencyMs : this.avgLatencyMs * 0.88 + this.lastLatencyMs * 0.12;

    const faces = this.#track(rawFaces, options);
    const events = this.#extractEvents(faces[0]);
    return { faces, events };
  }
}
