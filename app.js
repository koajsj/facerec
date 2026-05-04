import { FaceAlgorithm } from "./face-algorithm.js";

const video = document.getElementById("video");
const canvas = document.getElementById("overlay");
const ctx = canvas.getContext("2d");

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusText = document.getElementById("statusText");
const metricsText = document.getElementById("metricsText");

const detector = new FaceAlgorithm();
let stream = null;
let running = false;
let rafId = 0;
let lastVideoTime = -1;
let frameCounter = 0;
let latestBox = null;

function setStatus(text) {
  statusText.textContent = text;
}

function setMetrics(text) {
  metricsText.textContent = text;
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.floor(rect.width * dpr);
  const h = Math.floor(rect.height * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

function drawBox(box) {
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  if (!box || !video.videoWidth || !video.videoHeight) return;

  const sx = canvas.clientWidth / video.videoWidth;
  const sy = canvas.clientHeight / video.videoHeight;
  const x = box.x * sx;
  const y = box.y * sy;
  const w = box.w * sx;
  const h = box.h * sy;

  ctx.lineWidth = 2.4;
  ctx.strokeStyle = "rgba(0, 236, 185, 0.95)";
  ctx.shadowColor = "rgba(0, 236, 185, 0.42)";
  ctx.shadowBlur = 16;
  ctx.strokeRect(x, y, w, h);
  ctx.shadowBlur = 0;
}

async function startCamera() {
  stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: "user",
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 60 }
    },
    audio: false
  });
  video.srcObject = stream;
  await video.play();
}

function stopCamera() {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    track.stop();
  }
  stream = null;
}

function loop(ts) {
  if (!running) return;
  rafId = requestAnimationFrame(loop);

  resizeCanvas();
  if (video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;

  frameCounter++;
  // Detect every other frame to reduce load while keeping 60fps render feel.
  if (frameCounter % 2 === 0) {
    latestBox = detector.detect(video, ts);
  }

  drawBox(latestBox);
  if (latestBox) {
    setStatus("Tracking face");
    setMetrics(`confidence ${(latestBox.score * 100).toFixed(0)}% | latency ${latestBox.latencyMs.toFixed(1)}ms`);
  } else {
    setStatus("No face detected");
    setMetrics("face not found");
  }
}

async function start() {
  if (running) return;
  if (!window.isSecureContext) {
    setStatus("Camera requires HTTPS or localhost");
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Browser does not support camera APIs");
    return;
  }

  try {
    startBtn.disabled = true;
    setStatus("Initializing detector...");
    await detector.load(setStatus);
    setStatus("Starting camera...");
    await startCamera();

    running = true;
    lastVideoTime = -1;
    frameCounter = 0;
    latestBox = null;
    stopBtn.disabled = false;
    rafId = requestAnimationFrame(loop);
  } catch (err) {
    setStatus(`Start failed: ${err?.message || err}`);
  } finally {
    startBtn.disabled = false;
  }
}

function stop() {
  if (!running) return;
  running = false;
  cancelAnimationFrame(rafId);
  stopCamera();
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  latestBox = null;
  stopBtn.disabled = true;
  setStatus("Stopped");
  setMetrics("idle");
}

startBtn.addEventListener("click", start);
stopBtn.addEventListener("click", stop);
window.addEventListener("resize", resizeCanvas);
