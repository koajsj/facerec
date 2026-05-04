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
  debugOverlay: document.getElementById("debugOverlay")
};

const ctx = els.overlay.getContext("2d");
const detector = new FaceAlgorithm();
const appState = {
  state: "idle",
  running: false,
  stream: null,
  raf: 0,
  lastVideoTime: -1,
  frame: 0,
  lastDetectFaces: [],
  lostFrames: 0,
  lockId: null,
  debugOn: false,
  fps: 0,
  lastFpsTs: performance.now(),
  fpsCounter: 0,
  sessionLogs: [],
  dynamicSkip: 2
};

const config = {
  mode: "single",
  smoothFactor: 0.22,
  minConfidence: 0.6,
  showKeypoints: true,
  privacyMode: true,
  ttlMs: 300,
  detectEveryNFrames: 2,
  targetFps: 30,
  profile: "balance"
};

const STORAGE_KEY = "face_tracker_pro_v1";

function setState(state, message) {
  appState.state = state;
  els.statusText.textContent = `${state}${message ? ` | ${message}` : ""}`;
}

function setError(code, details = "") {
  setState("error", `${code}${details ? `: ${details}` : ""}`);
}

function saveConfig() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

function loadConfig() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    Object.assign(config, raw);
  } catch {
    // no-op
  }
}

function applyConfigToUi() {
  els.modeSelect.value = config.mode;
  els.perfSelect.value = config.profile;
  els.smoothRange.value = String(config.smoothFactor);
  els.confRange.value = String(config.minConfidence);
  els.kpToggle.checked = config.showKeypoints;
  els.privacyToggle.checked = config.privacyMode;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = els.overlay.getBoundingClientRect();
  const w = Math.floor(rect.width * dpr);
  const h = Math.floor(rect.height * dpr);
  if (els.overlay.width !== w || els.overlay.height !== h) {
    els.overlay.width = w;
    els.overlay.height = h;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

function setPerfProfile(profile) {
  config.profile = profile;
  if (profile === "high") {
    config.detectEveryNFrames = 1;
    config.targetFps = 45;
  } else if (profile === "save") {
    config.detectEveryNFrames = 3;
    config.targetFps = 24;
  } else {
    config.detectEveryNFrames = 2;
    config.targetFps = 30;
  }
}

function qualityPrompt(face) {
  if (!face) return "未检测到人脸";
  const area = (face.w * face.h) / ((els.video.videoWidth || 1) * (els.video.videoHeight || 1));
  const cx = face.x + face.w / 2;
  const yawRatio = Math.abs(cx / (els.video.videoWidth || 1) - 0.5) * 2;
  if (area < 0.06) return "距离偏远，请靠近";
  if (area > 0.55) return "距离过近，请后退";
  if (yawRatio > 0.45) return "请尽量正视镜头";
  return "追踪稳定";
}

function drawFace(face, color) {
  const sx = els.overlay.clientWidth / (els.video.videoWidth || 1);
  const sy = els.overlay.clientHeight / (els.video.videoHeight || 1);
  const x = face.x * sx;
  const y = face.y * sy;
  const w = face.w * sx;
  const h = face.h * sy;
  ctx.lineWidth = 2.2;
  ctx.strokeStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 14;
  ctx.strokeRect(x, y, w, h);
  ctx.shadowBlur = 0;
  if (config.showKeypoints && face.keypoints?.length) {
    ctx.fillStyle = "#7efce2";
    for (const kp of face.keypoints) {
      ctx.beginPath();
      ctx.arc(kp.x * sx, kp.y * sy, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.fillStyle = color;
  ctx.font = "12px Manrope";
  ctx.fillText(`#${face.id} ${(face.scoreAvg * 100).toFixed(0)}%`, x + 4, y - 6);
}

function render(faces) {
  ctx.clearRect(0, 0, els.overlay.clientWidth, els.overlay.clientHeight);
  faces.forEach((f, i) => drawFace(f, i === 0 ? "rgba(10,229,184,0.95)" : "rgba(255,184,77,0.95)"));
}

function updateDebug(latency, faces) {
  appState.fpsCounter++;
  const now = performance.now();
  if (now - appState.lastFpsTs >= 1000) {
    appState.fps = appState.fpsCounter;
    appState.fpsCounter = 0;
    appState.lastFpsTs = now;
  }
  if (!appState.debugOn) return;
  els.debugOverlay.classList.remove("hidden");
  const avgConf =
    faces.length > 0
      ? (faces.reduce((a, b) => a + (b.scoreAvg || b.score || 0), 0) / faces.length) * 100
      : 0;
  els.debugOverlay.textContent =
    `FPS: ${appState.fps}\n` +
    `Latency: ${latency.toFixed(1)}ms\n` +
    `AvgConf: ${avgConf.toFixed(1)}%\n` +
    `Faces: ${faces.length}\n` +
    `State: ${appState.state}\n` +
    `SkipN: ${config.detectEveryNFrames}`;
}

function adaptiveScheduler(latency) {
  // Budget scheduler: when inference is slow, lower detection frequency automatically.
  if (latency > 24) config.detectEveryNFrames = clamp(config.detectEveryNFrames + 1, 1, 4);
  else if (latency < 12) config.detectEveryNFrames = clamp(config.detectEveryNFrames - 1, 1, 4);
}

function logFrame(faces, latency) {
  if (config.privacyMode) return;
  appState.sessionLogs.push({
    t: Date.now(),
    latency: Number(latency.toFixed(2)),
    faces: faces.map((f) => ({
      id: f.id,
      x: Number(f.x.toFixed(1)),
      y: Number(f.y.toFixed(1)),
      w: Number(f.w.toFixed(1)),
      h: Number(f.h.toFixed(1)),
      score: Number((f.scoreAvg || f.score).toFixed(3))
    }))
  });
  if (appState.sessionLogs.length > 1200) appState.sessionLogs.shift();
}

async function startCamera() {
  try {
    appState.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
  } catch (err) {
    throw new Error(`E_CAMERA_DENIED ${err?.message || err}`);
  }
  els.video.srcObject = appState.stream;
  await els.video.play();
}

function stopCamera() {
  if (!appState.stream) return;
  appState.stream.getTracks().forEach((t) => t.stop());
  appState.stream = null;
}

function loop(ts) {
  if (!appState.running) return;
  appState.raf = requestAnimationFrame(loop);
  resizeCanvas();

  if (els.video.currentTime === appState.lastVideoTime) return;
  appState.lastVideoTime = els.video.currentTime;
  appState.frame++;

  let faces = appState.lastDetectFaces;
  if (appState.frame % config.detectEveryNFrames === 0) {
    faces = detector.detect(els.video, ts, {
      smoothFactor: config.smoothFactor,
      ttlMs: config.ttlMs,
      mode: config.mode,
      lockId: appState.lockId
    });
    appState.lastDetectFaces = faces;
    adaptiveScheduler(detector.avgLatencyMs);
  }

  if (faces.length === 0) {
    appState.lostFrames++;
    if (appState.lostFrames > 5) {
      els.metricsText.textContent = "face not found";
      els.qualityText.textContent = "未检测到人脸";
    }
  } else {
    appState.lostFrames = 0;
    const main = faces[0];
    els.metricsText.textContent = `conf ${(main.scoreAvg * 100).toFixed(0)}% | latency ${detector.avgLatencyMs.toFixed(1)}ms`;
    els.qualityText.textContent = qualityPrompt(main);
  }

  render(faces);
  updateDebug(detector.avgLatencyMs, faces);
  logFrame(faces, detector.avgLatencyMs);
}

async function start() {
  if (appState.running) return;
  if (!window.isSecureContext) return setError("E_INSECURE_CONTEXT", "需要HTTPS或localhost");
  if (!navigator.mediaDevices?.getUserMedia) return setError("E_API_UNSUPPORTED", "浏览器不支持摄像头API");
  try {
    setState("loading_model");
    detector.setMinConfidence(config.minConfidence);
    await detector.load((m) => setState("loading_model", m));
    setState("starting_camera");
    await startCamera();
    appState.running = true;
    appState.lastVideoTime = -1;
    appState.frame = 0;
    appState.lostFrames = 0;
    appState.lockId = null;
    appState.sessionLogs = [];
    els.stopBtn.disabled = false;
    els.shotBtn.disabled = false;
    els.exportBtn.disabled = false;
    setState("tracking");
    appState.raf = requestAnimationFrame(loop);
  } catch (err) {
    setError("E_START_FAIL", err?.message || String(err));
  }
}

function stop() {
  if (!appState.running) return;
  appState.running = false;
  cancelAnimationFrame(appState.raf);
  stopCamera();
  detector.reset();
  ctx.clearRect(0, 0, els.overlay.clientWidth, els.overlay.clientHeight);
  els.stopBtn.disabled = true;
  setState("stopped");
}

function applyPreset(name) {
  if (name === "meeting") {
    config.mode = "single";
    config.smoothFactor = 0.28;
    config.minConfidence = 0.65;
    setPerfProfile("balance");
  } else if (name === "selfie") {
    config.mode = "single";
    config.smoothFactor = 0.18;
    config.minConfidence = 0.55;
    setPerfProfile("high");
  } else {
    config.mode = "single";
    config.smoothFactor = 0.35;
    config.minConfidence = 0.62;
    setPerfProfile("save");
  }
  applyConfigToUi();
  detector.setMinConfidence(config.minConfidence);
  saveConfig();
}

function exportJson() {
  const payload = {
    exportedAt: new Date().toISOString(),
    profile: config.profile,
    privacyMode: config.privacyMode,
    state: appState.state,
    logs: appState.sessionLogs
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "face-tracker-session.json";
  a.click();
  URL.revokeObjectURL(url);
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
  const sx = c.width / (els.overlay.clientWidth || 1);
  const sy = c.height / (els.overlay.clientHeight || 1);
  cctx.drawImage(els.overlay, 0, 0, els.overlay.clientWidth * sx, els.overlay.clientHeight * sy);
  c.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `face-shot-${Date.now()}.png`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, "image/png");
}

function bindEvents() {
  els.startBtn.addEventListener("click", start);
  els.stopBtn.addEventListener("click", stop);
  els.shotBtn.addEventListener("click", snapshot);
  els.exportBtn.addEventListener("click", exportJson);
  els.debugBtn.addEventListener("click", () => {
    appState.debugOn = !appState.debugOn;
    if (!appState.debugOn) els.debugOverlay.classList.add("hidden");
  });
  els.themeBtn.addEventListener("click", () => {
    document.body.dataset.theme = document.body.dataset.theme === "dark" ? "light" : "dark";
  });
  els.modeSelect.addEventListener("change", () => {
    config.mode = els.modeSelect.value;
    saveConfig();
  });
  els.perfSelect.addEventListener("change", () => {
    setPerfProfile(els.perfSelect.value);
    saveConfig();
  });
  els.smoothRange.addEventListener("input", () => {
    config.smoothFactor = Number(els.smoothRange.value);
    saveConfig();
  });
  els.confRange.addEventListener("input", () => {
    config.minConfidence = Number(els.confRange.value);
    detector.setMinConfidence(config.minConfidence);
    saveConfig();
  });
  els.kpToggle.addEventListener("change", () => {
    config.showKeypoints = els.kpToggle.checked;
    saveConfig();
  });
  els.privacyToggle.addEventListener("change", () => {
    config.privacyMode = els.privacyToggle.checked;
    saveConfig();
  });
  els.presetMeeting.addEventListener("click", () => applyPreset("meeting"));
  els.presetSelfie.addEventListener("click", () => applyPreset("selfie"));
  els.presetLow.addEventListener("click", () => applyPreset("low"));
  els.overlay.addEventListener("click", (e) => {
    if (!appState.lastDetectFaces.length) return;
    const sx = (els.video.videoWidth || 1) / (els.overlay.clientWidth || 1);
    const sy = (els.video.videoHeight || 1) / (els.overlay.clientHeight || 1);
    const x = e.offsetX * sx;
    const y = e.offsetY * sy;
    const hit = appState.lastDetectFaces.find((f) => x >= f.x && x <= f.x + f.w && y >= f.y && y <= f.y + f.h);
    appState.lockId = hit ? hit.id : null;
  });
  window.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() === "s") start();
    if (e.key.toLowerCase() === "x") stop();
    if (e.key.toLowerCase() === "d") els.debugBtn.click();
  });
  window.addEventListener("resize", resizeCanvas);
}

loadConfig();
setPerfProfile(config.profile);
applyConfigToUi();
bindEvents();
setState("idle");
