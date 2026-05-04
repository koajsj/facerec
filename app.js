import { FaceAlgorithm } from "./face-algorithm.js";

const els = {
  video: document.getElementById("video"),
  overlay: document.getElementById("overlay"),
  toggleBtn: document.getElementById("toggleBtn"),
  modelBtn: document.getElementById("modelBtn"),
  toolsBtn: document.getElementById("toolsBtn"),
  toolsPanel: document.getElementById("toolsPanel"),
  shotBtn: document.getElementById("shotBtn"),
  themeBtn: document.getElementById("themeBtn"),
  statusText: document.getElementById("statusText"),
  metricsText: document.getElementById("metricsText"),
  qualityText: document.getElementById("qualityText"),
  eventText: document.getElementById("eventText")
};

const detector = new FaceAlgorithm();
const ctx = els.overlay.getContext("2d");
const app = { running: false, stream: null, raf: 0, frame: 0, lastVideoTime: -1, faces: [], events: [] };
const cfg = { model: "detector", smoothFactor: 0.45, minConfidence: 0.45, ttlMs: 260, detectEveryNFrames: 1 };

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function saveCfg() { localStorage.setItem("face_tracker_cn_v1", JSON.stringify(cfg)); }
function loadCfg() { try { Object.assign(cfg, JSON.parse(localStorage.getItem("face_tracker_cn_v1") || "{}")); } catch {} }
function updateModelButton() { els.modelBtn.textContent = `模式：${cfg.model === "detector" ? "检测器" : "关键点"}`; }

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const r = els.overlay.getBoundingClientRect();
  const w = Math.floor(r.width * dpr), h = Math.floor(r.height * dpr);
  if (els.overlay.width !== w || els.overlay.height !== h) {
    els.overlay.width = w;
    els.overlay.height = h;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

function quality(face) {
  if (!face) return "未检测到人脸";
  const area = (face.w * face.h) / ((els.video.videoWidth || 1) * (els.video.videoHeight || 1));
  if (area < 0.03) return "距离偏远";
  if (area > 0.7) return "距离过近";
  return "稳定";
}

function render(faces) {
  ctx.clearRect(0, 0, els.overlay.clientWidth, els.overlay.clientHeight);
  const sx = els.overlay.clientWidth / (els.video.videoWidth || 1);
  const sy = els.overlay.clientHeight / (els.video.videoHeight || 1);
  for (const f of faces) {
    const x = f.x * sx, y = f.y * sy, w = f.w * sx, h = f.h * sy;
    const color = "rgba(0, 245, 130, 0.96)";
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 12;
    ctx.strokeRect(x, y, w, h);
    ctx.shadowBlur = 0;
  }
}

async function startCamera() {
  app.stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 60 } },
    audio: false
  });
  els.video.srcObject = app.stream;
  await els.video.play();
}

function stopCamera() {
  if (!app.stream) return;
  app.stream.getTracks().forEach((t) => t.stop());
  app.stream = null;
}

function loop(ts) {
  if (!app.running) return;
  app.raf = requestAnimationFrame(loop);
  resizeCanvas();
  if (els.video.currentTime === app.lastVideoTime) return;
  app.lastVideoTime = els.video.currentTime;
  app.frame++;

  if (app.frame % cfg.detectEveryNFrames === 0) {
    const out = detector.detect(els.video, ts, {
      smoothFactor: cfg.smoothFactor,
      ttlMs: cfg.ttlMs,
      mode: "single",
      iouThreshold: 0.15,
      minBoxSize: 10
    });
    app.faces = out.faces;
    app.events = out.events;
    if (detector.avgLatencyMs > 26) cfg.detectEveryNFrames = clamp(cfg.detectEveryNFrames + 1, 1, 3);
    else if (detector.avgLatencyMs < 12) cfg.detectEveryNFrames = clamp(cfg.detectEveryNFrames - 1, 1, 3);
  }

  render(app.faces);
  els.metricsText.textContent = app.faces.length
    ? `置信度 ${(app.faces[0].scoreAvg * 100).toFixed(0)}%`
    : "未检测到人脸";
  els.qualityText.textContent = quality(app.faces[0]);
  els.eventText.textContent = app.events.length ? app.events.join("，") : "无";
}

async function start() {
  if (!window.isSecureContext) { els.statusText.textContent = "错误：需要 HTTPS 或 localhost"; return; }
  if (!navigator.mediaDevices?.getUserMedia) { els.statusText.textContent = "错误：浏览器不支持摄像头"; return; }
  try {
    els.statusText.textContent = "加载模型中...";
    detector.reset();
    detector.setMinConfidence(cfg.minConfidence);
    await detector.load(cfg.model, (m) => (els.statusText.textContent = m));
    els.statusText.textContent = "启动摄像头...";
    await startCamera();
    app.running = true;
    app.frame = 0;
    app.lastVideoTime = -1;
    els.toggleBtn.textContent = "停止";
    els.shotBtn.disabled = false;
    els.statusText.textContent = "追踪中";
    app.raf = requestAnimationFrame(loop);
  } catch (e) {
    els.statusText.textContent = `启动失败：${e?.message || e}`;
  }
}

function stop() {
  app.running = false;
  cancelAnimationFrame(app.raf);
  stopCamera();
  detector.reset();
  ctx.clearRect(0, 0, els.overlay.clientWidth, els.overlay.clientHeight);
  els.toggleBtn.textContent = "开始";
  els.statusText.textContent = "已停止";
}

function snapshot() {
  if (!els.video.videoWidth) return;
  const c = document.createElement("canvas");
  c.width = els.video.videoWidth;
  c.height = els.video.videoHeight;
  const cctx = c.getContext("2d");
  cctx.save();
  cctx.translate(c.width, 0);
  cctx.scale(-1, 1);
  cctx.drawImage(els.video, 0, 0, c.width, c.height);
  cctx.restore();
  cctx.drawImage(els.overlay, 0, 0, c.width, c.height);
  c.toBlob((b) => {
    if (!b) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b);
    a.download = `截图-${Date.now()}.png`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

function bind() {
  els.toggleBtn.onclick = async () => { if (app.running) stop(); else await start(); };
  els.modelBtn.onclick = () => { cfg.model = cfg.model === "detector" ? "landmarker" : "detector"; updateModelButton(); saveCfg(); };
  els.toolsBtn.onclick = () => { els.toolsPanel.open = !els.toolsPanel.open; };
  els.shotBtn.onclick = snapshot;
  els.themeBtn.onclick = () => { document.body.dataset.theme = document.body.dataset.theme === "dark" ? "light" : "dark"; };
}

loadCfg();
updateModelButton();
bind();
els.statusText.textContent = "待机";
