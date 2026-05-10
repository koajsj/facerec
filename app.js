import { FaceAlgorithm } from "./face-algorithm.js";

const els = {
  video: document.getElementById("video"),
  overlay: document.getElementById("overlay"),
  cameraWrap: document.getElementById("cameraWrap"),
  cameraEmpty: document.getElementById("cameraEmpty"),
  toggleBtn: document.getElementById("toggleBtn"),
  modeBtn: document.getElementById("modeBtn"),
  confidenceRange: document.getElementById("confidenceRange"),
  followRange: document.getElementById("followRange"),
  mirrorToggle: document.getElementById("mirrorToggle"),
  statusPill: document.getElementById("statusPill"),
  statusText: document.getElementById("statusText"),
  metricsText: document.getElementById("metricsText"),
  qualityText: document.getElementById("qualityText"),
  eventText: document.getElementById("eventText"),
  hintText: document.getElementById("hintText")
};

const detector = new FaceAlgorithm();
const ctx = els.overlay.getContext("2d", { alpha: true });

const modes = [
  { id: "balanced", label: "均衡", detectEvery: 1, confidence: 0.42, follow: 0.78 },
  { id: "fast", label: "快速", detectEvery: 1, confidence: 0.34, follow: 0.9 },
  { id: "stable", label: "稳定", detectEvery: 2, confidence: 0.5, follow: 0.62 }
];

const app = {
  running: false,
  starting: false,
  stream: null,
  raf: 0,
  frame: 0,
  lastVideoTime: -1,
  faces: [],
  events: [],
  modeIndex: 0,
  lastPanelUpdate: 0
};

const cfg = {
  minConfidence: modes[0].confidence,
  followSpeed: modes[0].follow,
  ttlMs: 300,
  detectEveryNFrames: modes[0].detectEvery,
  maxPixelRatio: 2
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function setStatus(text, type = "idle") {
  els.statusText.textContent = text;
  els.statusPill.textContent = text.length > 5 ? text.slice(0, 5) : text;
  els.statusPill.className = `status-pill ${type}`;
}

function setHint(text) {
  els.hintText.textContent = text;
}

function updateMode(index = app.modeIndex, syncControls = false) {
  app.modeIndex = index % modes.length;
  const mode = modes[app.modeIndex];
  if (syncControls) {
    els.confidenceRange.value = Math.round(mode.confidence * 100);
    els.followRange.value = Math.round(mode.follow * 100);
  }
  cfg.minConfidence = Number(els.confidenceRange.value) / 100 || mode.confidence;
  cfg.followSpeed = Number(els.followRange.value) / 100 || mode.follow;
  cfg.detectEveryNFrames = mode.detectEvery;
  els.modeBtn.textContent = mode.label;
  detector.setMinConfidence(cfg.minConfidence);
}

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, cfg.maxPixelRatio);
  const rect = els.overlay.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (els.overlay.width !== width || els.overlay.height !== height) {
    els.overlay.width = width;
    els.overlay.height = height;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function getCoverTransform() {
  const viewW = els.overlay.clientWidth || 1;
  const viewH = els.overlay.clientHeight || 1;
  const videoW = els.video.videoWidth || viewW;
  const videoH = els.video.videoHeight || viewH;
  const scale = Math.max(viewW / videoW, viewH / videoH);
  return {
    scale,
    offsetX: (viewW - videoW * scale) / 2,
    offsetY: (viewH - videoH * scale) / 2
  };
}

function mapFaceToCanvas(face) {
  const { scale, offsetX, offsetY } = getCoverTransform();
  const w = face.w * scale;
  let x = face.x * scale + offsetX;
  if (els.mirrorToggle.checked) {
    x = (els.overlay.clientWidth || 1) - x - w;
  }
  return {
    x,
    y: face.y * scale + offsetY,
    w,
    h: face.h * scale
  };
}

function roundRectPath(x, y, w, h, radius) {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
}

function drawFaceBox(face) {
  const box = mapFaceToCanvas(face);
  const line = Math.max(2.4, Math.min(4, box.w * 0.012));
  const corner = Math.max(18, Math.min(42, Math.min(box.w, box.h) * 0.18));
  const confidence = clamp(face.scoreAvg || face.score || 0, 0, 1);
  const alpha = 0.55 + confidence * 0.4;

  ctx.save();
  ctx.lineWidth = line;
  ctx.strokeStyle = `rgba(39, 242, 138, ${alpha})`;
  ctx.fillStyle = "rgba(39, 242, 138, 0.06)";
  ctx.shadowColor = "rgba(39, 242, 138, 0.8)";
  ctx.shadowBlur = 14;

  roundRectPath(box.x, box.y, box.w, box.h, 16);
  ctx.fill();

  ctx.beginPath();
  const x2 = box.x + box.w;
  const y2 = box.y + box.h;
  ctx.moveTo(box.x, box.y + corner);
  ctx.lineTo(box.x, box.y);
  ctx.lineTo(box.x + corner, box.y);
  ctx.moveTo(x2 - corner, box.y);
  ctx.lineTo(x2, box.y);
  ctx.lineTo(x2, box.y + corner);
  ctx.moveTo(x2, y2 - corner);
  ctx.lineTo(x2, y2);
  ctx.lineTo(x2 - corner, y2);
  ctx.moveTo(box.x + corner, y2);
  ctx.lineTo(box.x, y2);
  ctx.lineTo(box.x, y2 - corner);
  ctx.stroke();

  ctx.shadowBlur = 0;
  const label = `${Math.round(confidence * 100)}%`;
  const labelW = Math.max(52, ctx.measureText(label).width + 18);
  ctx.fillStyle = "rgba(4, 19, 10, 0.86)";
  roundRectPath(box.x, Math.max(8, box.y - 32), labelW, 24, 12);
  ctx.fill();
  ctx.fillStyle = "#8dffc1";
  ctx.font = "700 13px Microsoft YaHei, sans-serif";
  ctx.fillText(label, box.x + 9, Math.max(25, box.y - 15));
  ctx.restore();
}

function render(faces) {
  ctx.clearRect(0, 0, els.overlay.clientWidth, els.overlay.clientHeight);
  for (const face of faces) drawFaceBox(face);
}

function getQuality(face) {
  if (!face) return "未检测到";
  const videoArea = Math.max(1, (els.video.videoWidth || 1) * (els.video.videoHeight || 1));
  const ratio = (face.w * face.h) / videoArea;
  if ((face.scoreAvg || 0) < 0.45) return "光线或角度偏弱";
  if (ratio < 0.025) return "距离偏远";
  if (ratio > 0.72) return "距离过近";
  if (face.jitter > 16) return "移动较快";
  return "稳定";
}

function getEventText(events) {
  if (!events.length) return "无";
  const names = {
    blink: "眨眼",
    mouth_open: "张嘴",
    turn: "偏头"
  };
  return events.map((event) => names[event] || event).join("，");
}

function refreshPanel(force = false) {
  const now = performance.now();
  if (!force && now - app.lastPanelUpdate < 120) return;
  app.lastPanelUpdate = now;

  const face = app.faces[0];
  if (face) {
    els.metricsText.textContent = `置信度 ${Math.round((face.scoreAvg || face.score || 0) * 100)}% · ${Math.round(face.w)}×${Math.round(face.h)}`;
  } else {
    els.metricsText.textContent = "未检测到人脸";
  }
  els.qualityText.textContent = getQuality(face);
  els.eventText.textContent = getEventText(app.events);
}

async function startCamera() {
  app.stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: "user",
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 60, min: 24 }
    },
    audio: false
  });
  els.video.srcObject = app.stream;
  await els.video.play();
}

function stopCamera() {
  if (!app.stream) return;
  app.stream.getTracks().forEach((track) => track.stop());
  app.stream = null;
}

function loop(ts) {
  if (!app.running) return;
  app.raf = requestAnimationFrame(loop);

  resizeCanvas();
  if (els.video.currentTime === app.lastVideoTime) return;
  app.lastVideoTime = els.video.currentTime;
  app.frame += 1;

  if (app.frame % cfg.detectEveryNFrames === 0) {
    const result = detector.detect(els.video, ts, {
      followSpeed: cfg.followSpeed,
      ttlMs: cfg.ttlMs,
      iouThreshold: 0.11,
      minBoxSize: 7
    });
    app.faces = result.faces;
    app.events = result.events;

    if (detector.avgLatencyMs > 30) cfg.detectEveryNFrames = clamp(cfg.detectEveryNFrames + 1, 1, 3);
    else if (detector.avgLatencyMs < 16 && modes[app.modeIndex].id !== "stable") cfg.detectEveryNFrames = 1;
  }

  render(app.faces);
  refreshPanel();
}

async function start() {
  if (app.running || app.starting) return;
  if (!window.isSecureContext) {
    setStatus("需 HTTPS", "error");
    setHint("请使用 HTTPS 或 localhost 打开页面，浏览器才允许访问摄像头。");
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("不支持", "error");
    setHint("当前浏览器不支持摄像头 API。");
    return;
  }

  app.starting = true;
  els.toggleBtn.disabled = true;
  setStatus("加载中", "warn");
  setHint("正在加载本地识别模型，请稍候。");

  try {
    detector.reset();
    updateMode();
    await detector.load((msg) => setStatus(msg, "warn"));
    setStatus("开相机", "warn");
    await startCamera();

    app.running = true;
    app.frame = 0;
    app.lastVideoTime = -1;
    app.faces = [];
    app.events = [];
    els.cameraEmpty.classList.add("hidden");
    els.toggleBtn.textContent = "停止";
    setStatus("追踪中", "live");
    setHint("识别框会按脸部移动速度自适应跟随。移动过快时会降低平滑以减少延迟。");
    app.raf = requestAnimationFrame(loop);
  } catch (error) {
    setStatus("启动失败", "error");
    setHint(error?.message || String(error));
    stopCamera();
  } finally {
    app.starting = false;
    els.toggleBtn.disabled = false;
  }
}

function stop() {
  app.running = false;
  app.starting = false;
  cancelAnimationFrame(app.raf);
  stopCamera();
  detector.reset();
  app.faces = [];
  app.events = [];
  ctx.clearRect(0, 0, els.overlay.clientWidth, els.overlay.clientHeight);
  els.cameraEmpty.classList.remove("hidden");
  els.toggleBtn.textContent = "开始";
  setStatus("已停止", "idle");
  setHint("保持脸部在画面中央，光线稳定时识别框会更稳。");
  refreshPanel(true);
}

function bindEvents() {
  els.toggleBtn.addEventListener("click", async () => {
    if (app.running) stop();
    else await start();
  });

  els.modeBtn.addEventListener("click", () => {
    updateMode(app.modeIndex + 1, true);
    setHint(`已切换到${modes[app.modeIndex].label}模式。`);
  });

  els.confidenceRange.addEventListener("input", () => {
    cfg.minConfidence = Number(els.confidenceRange.value) / 100;
    detector.setMinConfidence(cfg.minConfidence);
  });

  els.followRange.addEventListener("input", () => {
    cfg.followSpeed = Number(els.followRange.value) / 100;
  });

  els.mirrorToggle.addEventListener("change", () => {
    els.cameraWrap.classList.toggle("mirrored", els.mirrorToggle.checked);
  });

  window.addEventListener("resize", resizeCanvas);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && app.running) stop();
  });
}

els.cameraWrap.classList.toggle("mirrored", els.mirrorToggle.checked);
bindEvents();
updateMode(0, true);
refreshPanel(true);
setStatus("待机", "idle");
