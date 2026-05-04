import { FaceAlgorithm } from "./face-algorithm.js";

const els = {
  video: document.getElementById("video"),
  overlay: document.getElementById("overlay"),
  startBtn: document.getElementById("startBtn"),
  stopBtn: document.getElementById("stopBtn"),
  shotBtn: document.getElementById("shotBtn"),
  exportBtn: document.getElementById("exportBtn"),
  debugBtn: document.getElementById("debugBtn"),
  themeBtn: document.getElementById("themeBtn"),
  modeSelect: document.getElementById("modeSelect"),
  modelSelect: document.getElementById("modelSelect"),
  perfSelect: document.getElementById("perfSelect"),
  smoothRange: document.getElementById("smoothRange"),
  confRange: document.getElementById("confRange"),
  kpToggle: document.getElementById("kpToggle"),
  privacyToggle: document.getElementById("privacyToggle"),
  presetMeeting: document.getElementById("presetMeeting"),
  presetSelfie: document.getElementById("presetSelfie"),
  presetLow: document.getElementById("presetLow"),
  statusText: document.getElementById("statusText"),
  metricsText: document.getElementById("metricsText"),
  qualityText: document.getElementById("qualityText"),
  eventText: document.getElementById("eventText"),
  debugOverlay: document.getElementById("debugOverlay")
};

const detector = new FaceAlgorithm();
const ctx = els.overlay.getContext("2d");
const app = { running: false, stream: null, raf: 0, frame: 0, lastVideoTime: -1, faces: [], lockId: null, debugOn: false, fps: 0, fpsCount: 0, fpsTick: performance.now(), events: [] };
const cfg = { mode: "single", model: "detector", smoothFactor: 0.22, minConfidence: 0.6, showKeypoints: true, privacyMode: true, ttlMs: 300, detectEveryNFrames: 2, profile: "balance" };

function setState(s, m = "") { els.statusText.textContent = m ? `${s} | ${m}` : s; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function saveCfg() { localStorage.setItem("face_tracker_pro_v1", JSON.stringify(cfg)); }
function loadCfg() { try { Object.assign(cfg, JSON.parse(localStorage.getItem("face_tracker_pro_v1") || "{}")); } catch {} }

function applyCfg() {
  els.modeSelect.value = cfg.mode;
  els.modelSelect.value = cfg.model;
  els.perfSelect.value = cfg.profile;
  els.smoothRange.value = String(cfg.smoothFactor);
  els.confRange.value = String(cfg.minConfidence);
  els.kpToggle.checked = cfg.showKeypoints;
  els.privacyToggle.checked = cfg.privacyMode;
}

function setPerfProfile(p) {
  cfg.profile = p;
  cfg.detectEveryNFrames = p === "high" ? 1 : p === "save" ? 3 : 2;
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = els.overlay.getBoundingClientRect();
  const w = Math.floor(rect.width * dpr), h = Math.floor(rect.height * dpr);
  if (els.overlay.width !== w || els.overlay.height !== h) {
    els.overlay.width = w; els.overlay.height = h; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

function qualityPrompt(face) {
  if (!face) return "No face";
  const area = (face.w * face.h) / ((els.video.videoWidth || 1) * (els.video.videoHeight || 1));
  const cx = face.x + face.w / 2;
  const yaw = Math.abs(cx / (els.video.videoWidth || 1) - 0.5) * 2;
  if (area < 0.06) return "Move closer";
  if (area > 0.55) return "Move back";
  if (yaw > 0.45) return "Face camera";
  return "Stable";
}

function render(faces) {
  ctx.clearRect(0, 0, els.overlay.clientWidth, els.overlay.clientHeight);
  const sx = els.overlay.clientWidth / (els.video.videoWidth || 1);
  const sy = els.overlay.clientHeight / (els.video.videoHeight || 1);
  faces.forEach((f, i) => {
    const color = i === 0 ? "rgba(47,231,255,0.95)" : "rgba(30,197,157,0.95)";
    const x = f.x * sx, y = f.y * sy, w = f.w * sx, h = f.h * sy;
    ctx.lineWidth = 2.2; ctx.strokeStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 14; ctx.strokeRect(x, y, w, h); ctx.shadowBlur = 0;
    if (cfg.showKeypoints && f.keypoints?.length) {
      ctx.fillStyle = color;
      for (const p of f.keypoints) { ctx.beginPath(); ctx.arc(p.x * sx, p.y * sy, 2, 0, Math.PI * 2); ctx.fill(); }
    }
  });
}

function updateDebug() {
  app.fpsCount++;
  const now = performance.now();
  if (now - app.fpsTick >= 1000) { app.fps = app.fpsCount; app.fpsCount = 0; app.fpsTick = now; }
  if (!app.debugOn) return;
  els.debugOverlay.classList.remove("hidden");
  const avg = app.faces.length ? (app.faces.reduce((s, f) => s + (f.scoreAvg || 0), 0) / app.faces.length) * 100 : 0;
  els.debugOverlay.textContent = `FPS: ${app.fps}\nLatency: ${detector.avgLatencyMs.toFixed(1)}ms\nFaces: ${app.faces.length}\nAvgConf: ${avg.toFixed(1)}%\nModel: ${cfg.model}`;
}

async function startCamera() {
  app.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  els.video.srcObject = app.stream;
  await els.video.play();
}
function stopCamera() { if (!app.stream) return; app.stream.getTracks().forEach((t) => t.stop()); app.stream = null; }

function loop(ts) {
  if (!app.running) return;
  app.raf = requestAnimationFrame(loop);
  resizeCanvas();
  if (els.video.currentTime === app.lastVideoTime) return;
  app.lastVideoTime = els.video.currentTime;
  app.frame++;

  if (app.frame % cfg.detectEveryNFrames === 0) {
    const out = detector.detect(els.video, ts, { smoothFactor: cfg.smoothFactor, ttlMs: cfg.ttlMs, mode: cfg.mode, lockId: app.lockId, iouThreshold: 0.2 });
    app.faces = out.faces;
    app.events = out.events;
    if (detector.avgLatencyMs > 24) cfg.detectEveryNFrames = clamp(cfg.detectEveryNFrames + 1, 1, 4);
    else if (detector.avgLatencyMs < 11) cfg.detectEveryNFrames = clamp(cfg.detectEveryNFrames - 1, 1, 4);
  }

  render(app.faces);
  if (app.faces.length) {
    const m = app.faces[0];
    els.metricsText.textContent = `conf ${(m.scoreAvg * 100).toFixed(0)}% | latency ${detector.avgLatencyMs.toFixed(1)}ms`;
  } else {
    els.metricsText.textContent = "face not found";
  }
  els.qualityText.textContent = qualityPrompt(app.faces[0]);
  els.eventText.textContent = app.events.length ? app.events.join(", ") : "none";
  updateDebug();
}

async function start() {
  if (app.running) return;
  if (!window.isSecureContext) return setState("error", "E_INSECURE_CONTEXT");
  if (!navigator.mediaDevices?.getUserMedia) return setState("error", "E_API_UNSUPPORTED");
  try {
    setState("loading_model");
    detector.reset();
    detector.setMinConfidence(cfg.minConfidence);
    await detector.load(cfg.model, (m) => setState("loading_model", m));
    setState("starting_camera");
    await startCamera();
    app.running = true; app.frame = 0; app.lastVideoTime = -1; app.lockId = null; app.events = [];
    els.stopBtn.disabled = false; els.shotBtn.disabled = false; els.exportBtn.disabled = false;
    setState("tracking");
    app.raf = requestAnimationFrame(loop);
  } catch (e) { setState("error", `E_START_FAIL ${e?.message || e}`); }
}

function stop() {
  if (!app.running) return;
  app.running = false;
  cancelAnimationFrame(app.raf);
  stopCamera();
  detector.reset();
  ctx.clearRect(0, 0, els.overlay.clientWidth, els.overlay.clientHeight);
  els.stopBtn.disabled = true;
  setState("stopped");
}

function snapshot() {
  if (!els.video.videoWidth) return;
  const c = document.createElement("canvas");
  c.width = els.video.videoWidth; c.height = els.video.videoHeight;
  const cctx = c.getContext("2d");
  cctx.save(); cctx.translate(c.width, 0); cctx.scale(-1, 1); cctx.drawImage(els.video, 0, 0, c.width, c.height); cctx.restore();
  cctx.drawImage(els.overlay, 0, 0, c.width, c.height);
  c.toBlob((b) => {
    if (!b) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b); a.download = `face-shot-${Date.now()}.png`; a.click();
    URL.revokeObjectURL(a.href);
  });
}
function exportJson() {
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), profile: cfg.profile, model: cfg.model, events: app.events }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "face-tracker-session.json"; a.click();
  URL.revokeObjectURL(a.href);
}

function bind() {
  els.startBtn.onclick = start;
  els.stopBtn.onclick = stop;
  els.shotBtn.onclick = snapshot;
  els.exportBtn.onclick = exportJson;
  els.themeBtn.onclick = () => { document.body.dataset.theme = document.body.dataset.theme === "dark" ? "light" : "dark"; };
  els.debugBtn.onclick = () => { app.debugOn = !app.debugOn; els.debugOverlay.classList.toggle("hidden", !app.debugOn); };
  els.modeSelect.onchange = () => { cfg.mode = els.modeSelect.value; saveCfg(); };
  els.modelSelect.onchange = () => { cfg.model = els.modelSelect.value; saveCfg(); setState("idle", `model=${cfg.model}`); };
  els.perfSelect.onchange = () => { setPerfProfile(els.perfSelect.value); saveCfg(); };
  els.smoothRange.oninput = () => { cfg.smoothFactor = Number(els.smoothRange.value); saveCfg(); };
  els.confRange.oninput = () => { cfg.minConfidence = Number(els.confRange.value); detector.setMinConfidence(cfg.minConfidence); saveCfg(); };
  els.kpToggle.onchange = () => { cfg.showKeypoints = els.kpToggle.checked; saveCfg(); };
  els.privacyToggle.onchange = () => { cfg.privacyMode = els.privacyToggle.checked; saveCfg(); };
  els.presetMeeting.onclick = () => { cfg.mode = "single"; cfg.smoothFactor = 0.28; cfg.minConfidence = 0.65; cfg.model = "detector"; setPerfProfile("balance"); applyCfg(); saveCfg(); };
  els.presetSelfie.onclick = () => { cfg.mode = "single"; cfg.smoothFactor = 0.18; cfg.minConfidence = 0.55; cfg.model = "landmarker"; setPerfProfile("high"); applyCfg(); saveCfg(); };
  els.presetLow.onclick = () => { cfg.mode = "single"; cfg.smoothFactor = 0.35; cfg.minConfidence = 0.62; cfg.model = "detector"; setPerfProfile("save"); applyCfg(); saveCfg(); };
  window.onresize = resizeCanvas;
  window.onkeydown = (e) => {
    if (e.key.toLowerCase() === "s") start();
    if (e.key.toLowerCase() === "x") stop();
    if (e.key.toLowerCase() === "d") els.debugBtn.click();
  };
}

loadCfg();
setPerfProfile(cfg.profile);
applyCfg();
bind();
setState("idle");
