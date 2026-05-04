import { FaceAlgorithm } from "./face-algorithm.js";

const els = {
  video: document.getElementById("video"),
  overlay: document.getElementById("overlay"),
  toggleBtn: document.getElementById("toggleBtn"),
  statusText: document.getElementById("statusText"),
  metricsText: document.getElementById("metricsText"),
  qualityText: document.getElementById("qualityText"),
  eventText: document.getElementById("eventText")
};

const detector = new FaceAlgorithm();
const ctx = els.overlay.getContext("2d");
const app = {
  running: false,
  starting: false,
  stream: null,
  raf: 0,
  frame: 0,
  lastVideoTime: -1,
  faces: [],
  events: []
};

const cfg = {
  smoothFactor: 0.45,
  minConfidence: 0.45,
  ttlMs: 260,
  detectEveryNFrames: 1
};

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function setStatus(text) {
  els.statusText.textContent = text;
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = els.overlay.getBoundingClientRect();
  const width = Math.floor(rect.width * dpr);
  const height = Math.floor(rect.height * dpr);
  if (els.overlay.width !== width || els.overlay.height !== height) {
    els.overlay.width = width;
    els.overlay.height = height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

function getQuality(face) {
  if (!face) return "未检测到人脸";
  const ratio = (face.w * face.h) / ((els.video.videoWidth || 1) * (els.video.videoHeight || 1));
  if (ratio < 0.03) return "距离偏远";
  if (ratio > 0.7) return "距离过近";
  return "稳定";
}

function renderBoxes(faces) {
  ctx.clearRect(0, 0, els.overlay.clientWidth, els.overlay.clientHeight);
  const sx = els.overlay.clientWidth / (els.video.videoWidth || 1);
  const sy = els.overlay.clientHeight / (els.video.videoHeight || 1);
  for (const face of faces) {
    const x = face.x * sx;
    const y = face.y * sy;
    const w = face.w * sx;
    const h = face.h * sy;
    const green = "rgba(0,245,130,0.96)";
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = green;
    ctx.shadowColor = green;
    ctx.shadowBlur = 12;
    ctx.strokeRect(x, y, w, h);
    ctx.shadowBlur = 0;
  }
}

function refreshPanel() {
  if (app.faces.length > 0) {
    const conf = ((app.faces[0].scoreAvg || 0) * 100).toFixed(1);
    els.metricsText.textContent = `置信度 ${conf}%`;
  } else {
    els.metricsText.textContent = "未检测到人脸";
  }
  els.qualityText.textContent = getQuality(app.faces[0]);
  els.eventText.textContent = app.events.length ? app.events.join("，") : "无";
}

async function startCamera() {
  app.stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: "user",
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 60 }
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
      smoothFactor: cfg.smoothFactor,
      ttlMs: cfg.ttlMs,
      iouThreshold: 0.15,
      minBoxSize: 8
    });
    app.faces = result.faces;
    app.events = result.events;
    if (detector.avgLatencyMs > 26) cfg.detectEveryNFrames = clamp(cfg.detectEveryNFrames + 1, 1, 3);
    else if (detector.avgLatencyMs < 12) cfg.detectEveryNFrames = clamp(cfg.detectEveryNFrames - 1, 1, 3);
  }

  renderBoxes(app.faces);
  refreshPanel();
}

async function start() {
  if (app.running || app.starting) return;
  if (!window.isSecureContext) return setStatus("错误：需要 HTTPS 或 localhost");
  if (!navigator.mediaDevices?.getUserMedia) return setStatus("错误：浏览器不支持摄像头");

  app.starting = true;
  els.toggleBtn.disabled = true;

  try {
    setStatus("加载模型中...");
    detector.reset();
    detector.setMinConfidence(cfg.minConfidence);
    await detector.load((msg) => setStatus(msg));

    setStatus("启动摄像头...");
    await startCamera();

    app.running = true;
    app.frame = 0;
    app.lastVideoTime = -1;
    app.faces = [];
    app.events = [];

    els.toggleBtn.textContent = "停止";
    setStatus("追踪中");
    app.raf = requestAnimationFrame(loop);
  } catch (err) {
    setStatus(`启动失败：${err?.message || err}`);
  } finally {
    app.starting = false;
    els.toggleBtn.disabled = false;
  }
}

function stop() {
  if (!app.running && !app.starting) return;
  app.running = false;
  app.starting = false;
  cancelAnimationFrame(app.raf);
  stopCamera();
  detector.reset();
  app.faces = [];
  app.events = [];
  ctx.clearRect(0, 0, els.overlay.clientWidth, els.overlay.clientHeight);
  els.toggleBtn.textContent = "开始";
  setStatus("已停止");
  refreshPanel();
}

function bindEvents() {
  els.toggleBtn.onclick = async () => {
    if (app.running) stop();
    else await start();
  };

  window.addEventListener("resize", resizeCanvas);
}

bindEvents();
refreshPanel();
setStatus("待机");
