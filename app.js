import { FaceAlgorithm } from "./face-algorithm.js";

const els = {
  video: document.getElementById("video"),
  overlay: document.getElementById("overlay"),
  cameraWrap: document.getElementById("cameraWrap"),
  cameraEmpty: document.getElementById("cameraEmpty"),
  cameraEmptyTitle: document.getElementById("cameraEmptyTitle"),
  cameraEmptyText: document.getElementById("cameraEmptyText"),
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
const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");

const modes = [
  { id: "balanced", label: "均衡", detectEvery: 1, confidence: 0.42, follow: 0.78 },
  { id: "fast", label: "快速", detectEvery: 1, confidence: 0.34, follow: 0.9 },
  { id: "stable", label: "稳定", detectEvery: 2, confidence: 0.5, follow: 0.62 }
];

const STATUS_COPY = {
  idle: "待机",
  loading: "加载中",
  live: "追踪中",
  warn: "准备中",
  error: "异常"
};

const DEFAULT_HINT = "保持脸部在画面中央，光线稳定时识别框会更稳。";

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

function setBodyState(state) {
  document.body.dataset.state = state;
}

function setThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    return;
  }

  meta.setAttribute("content", themeMedia.matches ? "#101318" : "#f4f1ea");
}

function setStatus(text, type = "idle") {
  els.statusText.textContent = text;
  els.statusPill.textContent = text.length > 5 ? text.slice(0, 5) : text;
  els.statusPill.className = `status-pill ${type}`;
}

function setHint(text) {
  els.hintText.textContent = text;
}

function setCameraEmpty(title, text) {
  if (els.cameraEmptyTitle) {
    els.cameraEmptyTitle.textContent = title;
  }
  if (els.cameraEmptyText) {
    els.cameraEmptyText.textContent = text;
  }
}

function showCameraEmpty(title, text) {
  els.cameraEmpty.classList.remove("hidden");
  setCameraEmpty(title, text);
}

function hideCameraEmpty() {
  els.cameraEmpty.classList.add("hidden");
}

function updateMode(index = app.modeIndex, syncControls = false) {
  app.modeIndex = ((index % modes.length) + modes.length) % modes.length;
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
  if (!ctx) {
    return;
  }

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
  const line = Math.max(2.2, Math.min(4, box.w * 0.011));
  const corner = Math.max(16, Math.min(36, Math.min(box.w, box.h) * 0.17));
  const confidence = clamp(face.scoreAvg || face.score || 0, 0, 1);
  const alpha = 0.5 + confidence * 0.38;

  ctx.save();
  ctx.lineWidth = line;
  ctx.strokeStyle = `rgba(56, 198, 121, ${alpha})`;
  ctx.fillStyle = "rgba(56, 198, 121, 0.07)";
  ctx.shadowColor = "rgba(56, 198, 121, 0.42)";
  ctx.shadowBlur = 10;

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
  ctx.fillStyle = "rgba(16, 19, 24, 0.88)";
  roundRectPath(box.x, Math.max(8, box.y - 32), labelW, 24, 12);
  ctx.fill();
  ctx.fillStyle = "#b6f7cd";
  ctx.font = "700 13px \"Microsoft YaHei\", sans-serif";
  ctx.fillText(label, box.x + 9, Math.max(25, box.y - 15));
  ctx.restore();
}

function render(faces) {
  if (!ctx) {
    return;
  }

  ctx.clearRect(0, 0, els.overlay.clientWidth, els.overlay.clientHeight);
  for (const face of faces) {
    drawFaceBox(face);
  }
}

function getQuality(face) {
  if (!face) {
    return "未检测到";
  }

  const videoArea = Math.max(1, (els.video.videoWidth || 1) * (els.video.videoHeight || 1));
  const ratio = (face.w * face.h) / videoArea;

  if ((face.scoreAvg || 0) < 0.45) {
    return "光线或角度偏弱";
  }
  if (ratio < 0.025) {
    return "距离偏远";
  }
  if (ratio > 0.72) {
    return "距离过近";
  }
  if (face.jitter > 16) {
    return "移动较快";
  }
  return "稳定";
}

function getEventText(events) {
  if (!events.length) {
    return "无";
  }

  const names = {
    blink: "眨眼",
    mouth_open: "张嘴",
    turn: "偏头"
  };

  return events.map((event) => names[event] || event).join("，");
}

function refreshPanel(force = false) {
  const now = performance.now();
  if (!force && now - app.lastPanelUpdate < 120) {
    return;
  }

  app.lastPanelUpdate = now;

  if (!app.running && !app.starting) {
    if (document.body.dataset.state === "error") {
      els.metricsText.textContent = "发生错误";
      els.qualityText.textContent = "请重试";
      els.eventText.textContent = "无";
      return;
    }

    els.metricsText.textContent = "等待开始";
    els.qualityText.textContent = "待机";
    els.eventText.textContent = "无";
    return;
  }

  if (app.starting) {
    els.metricsText.textContent = "正在加载";
    els.qualityText.textContent = "准备中";
    els.eventText.textContent = "无";
    return;
  }

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
  const constraints = {
    video: {
      facingMode: "user",
      width: { ideal: 960 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, min: 24 }
    },
    audio: false
  };

  app.stream = await navigator.mediaDevices.getUserMedia(constraints);
  els.video.srcObject = app.stream;
  await els.video.play();
}

function stopCamera() {
  if (!app.stream) {
    return;
  }

  app.stream.getTracks().forEach((track) => track.stop());
  app.stream = null;
  els.video.srcObject = null;
}

function friendlyStartError(error) {
  const name = String(error?.name || "");
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "摄像头权限被拒绝，请在浏览器地址栏左侧重新允许访问。";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "没有找到可用摄像头，请检查设备连接或切换输入设备。";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "摄像头暂时无法打开，请关闭其他正在占用摄像头的程序后重试。";
  }
  return error?.message || "启动失败，请稍后重试。";
}

function friendlyLoadError(error) {
  if (String(error?.message || error).includes("module")) {
    return "本地模型加载失败，请检查网络后重新开始。";
  }
  return error?.message || "模型加载失败，请稍后重试。";
}

function resetStoppedState({ keepError = false } = {}) {
  app.running = false;
  app.starting = false;
  cancelAnimationFrame(app.raf);
  app.raf = 0;
  stopCamera();
  detector.reset();
  app.faces = [];
  app.events = [];
  if (ctx) {
    ctx.clearRect(0, 0, els.overlay.clientWidth, els.overlay.clientHeight);
  }
  els.toggleBtn.textContent = "开始";
  setBodyState(keepError ? "error" : "idle");
  setStatus(keepError ? STATUS_COPY.error : STATUS_COPY.idle, keepError ? "error" : "idle");
  setHint(DEFAULT_HINT);
  if (!keepError) {
    showCameraEmpty("摄像头未启动", "点击开始后在本机完成识别，不上传画面。");
  }
  refreshPanel(true);
}

async function start() {
  if (app.running || app.starting) {
    return;
  }

  if (!window.isSecureContext) {
    setBodyState("error");
    showCameraEmpty("需要 HTTPS", "请用 localhost 或 HTTPS 打开页面，浏览器才允许访问摄像头。");
    setStatus("需要 HTTPS", "error");
    setHint("请在 localhost 或 HTTPS 环境中打开页面。");
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    setBodyState("error");
    showCameraEmpty("浏览器不支持", "当前浏览器不支持摄像头 API。");
    setStatus("不支持", "error");
    setHint("请换一个支持摄像头访问的现代浏览器。");
    return;
  }

  app.starting = true;
  els.toggleBtn.disabled = true;
  setBodyState("loading");
  setStatus(STATUS_COPY.loading, "warn");
  setHint("正在加载本地识别模型和摄像头权限，请稍候。");
  showCameraEmpty("正在初始化", "正在加载识别模型和摄像头权限。");
  refreshPanel(true);

  try {
    detector.reset();
    updateMode();
    await detector.load((message) => setStatus(message, "warn"));
    setStatus("准备摄像头", "warn");
    await startCamera();

    app.running = true;
    app.frame = 0;
    app.lastVideoTime = -1;
    app.faces = [];
    app.events = [];
    hideCameraEmpty();
    els.toggleBtn.textContent = "停止";
    setBodyState("live");
    setStatus(STATUS_COPY.live, "live");
    setHint("识别框会根据移动速度自动调整，画面越稳定越顺滑。");
    app.raf = requestAnimationFrame(loop);
  } catch (error) {
    const message = friendlyStartError(error);
    setBodyState("error");
    showCameraEmpty("启动失败", message);
    setStatus("启动失败", "error");
    setHint(message);
    stopCamera();
    detector.reset();
  } finally {
    app.starting = false;
    els.toggleBtn.disabled = false;
    refreshPanel(true);
  }
}

function stop() {
  resetStoppedState();
}

function loop(ts) {
  if (!app.running) {
    return;
  }

  app.raf = requestAnimationFrame(loop);

  resizeCanvas();
  if (els.video.currentTime === app.lastVideoTime) {
    return;
  }

  app.lastVideoTime = els.video.currentTime;
  app.frame += 1;

  if (app.frame % cfg.detectEveryNFrames === 0) {
    try {
      const result = detector.detect(els.video, ts, {
        followSpeed: cfg.followSpeed,
        ttlMs: cfg.ttlMs,
        iouThreshold: 0.11,
        minBoxSize: 7
      });

      app.faces = result.faces;
      app.events = result.events;

      if (detector.avgLatencyMs > 30) {
        cfg.detectEveryNFrames = clamp(cfg.detectEveryNFrames + 1, 1, 3);
      } else if (detector.avgLatencyMs < 16 && modes[app.modeIndex].id !== "stable") {
        cfg.detectEveryNFrames = 1;
      }
    } catch (error) {
      const message = friendlyLoadError(error);
      app.running = false;
      cancelAnimationFrame(app.raf);
      app.raf = 0;
      stopCamera();
      detector.reset();
      app.faces = [];
      app.events = [];
      els.toggleBtn.textContent = "开始";
      setBodyState("error");
      showCameraEmpty("识别异常", message);
      setStatus("识别异常", "error");
      setHint(message);
      refreshPanel(true);
      return;
    }
  }

  render(app.faces);
  refreshPanel();
}

function bindEvents() {
  els.toggleBtn.addEventListener("click", async () => {
    if (app.running) {
      stop();
    } else {
      await start();
    }
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
  window.addEventListener("beforeunload", stop);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && app.running) {
      stop();
    }
  });
  if (typeof themeMedia.addEventListener === "function") {
    themeMedia.addEventListener("change", setThemeColor);
  } else if (typeof themeMedia.addListener === "function") {
    themeMedia.addListener(setThemeColor);
  }
}

function init() {
  if (!ctx) {
    showCameraEmpty("浏览器不支持 Canvas", "当前浏览器无法绘制识别框，请更换现代浏览器。");
    setStatus("不支持", "error");
    setHint("需要 Canvas 2D 支持才能显示识别结果。");
    setBodyState("error");
    els.toggleBtn.disabled = true;
    return;
  }

  setThemeColor();
  els.cameraWrap.classList.toggle("mirrored", els.mirrorToggle.checked);
  updateMode(0, true);
  setBodyState("idle");
  setStatus(STATUS_COPY.idle, "idle");
  setHint(DEFAULT_HINT);
  showCameraEmpty("摄像头未启动", "点击开始后在本机完成识别，不上传画面。");
  refreshPanel(true);
  bindEvents();
}

init();
