// Hand control (camera) — grab and move.
//   Pinch thumb + index          → grab the orb
//   move your hand while pinched → spin it
//   move nearer / further        → bigger / smaller
//   open your fingers            → let go
// Nothing moves unless you're pinching, so a relaxed hand can never make the orb drift.
// Press H to show or hide the little camera preview. Everything runs on this device.
import { FilesetResolver, HandLandmarker } from '/vendor/mediapipe/vision_bundle.mjs';

const $btn = document.getElementById('hand');
const $view = document.getElementById('handview');
const vctx = $view?.getContext('2d');
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Live-tweakable from the console as __handTuning.
const T = {
  PINCH_ON: .42,     // pinch counts as closed below this (relative to hand size)
  PINCH_OFF: .62,    // and open again above this
  FRAMES_ON: 2,      // frames to confirm a grab
  FRAMES_OFF: 3,     // frames to confirm a release
  SPIN: 6,           // how far a hand movement turns the orb
  SPIN_DEADBAND: .003,
  SPIN_RATE: 4,      // max radians per second
  ZOOM_POWER: 1.6,   // how strongly nearer/further changes the size
  ZOOM_RATE: 2.5,    // max size change per second
  MIN_HAND: .08,     // ignore hands too far away to track properly
  SMOOTH: 1.6,       // One-Euro cutoff (higher = more responsive, lower = steadier)
  TRACK_FPS: 24,     // how often to look at the camera (lower = smoother orb on slower PCs)
};

class Median {
  constructor(n = 3) { this.n = n; this.buf = []; }
  push(v) { this.buf.push(v); if (this.buf.length > this.n) this.buf.shift(); return [...this.buf].sort((a, b) => a - b)[this.buf.length >> 1]; }
  reset() { this.buf = []; }
}
class OneEuro {
  constructor(minCutoff = T.SMOOTH, beta = .5) { Object.assign(this, { minCutoff, beta, x: null, dx: 0, t: 0 }); }
  static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  filter(v, now) {
    if (this.x == null) { this.x = v; this.t = now; return v; }
    const dt = clamp((now - this.t) / 1000, 1 / 120, .2); this.t = now;
    const d = (v - this.x) / dt;
    this.dx += OneEuro.alpha(1, dt) * (d - this.dx);
    this.x += OneEuro.alpha(this.minCutoff + this.beta * Math.abs(this.dx), dt) * (v - this.x);
    return this.x;
  }
  reset() { this.x = null; this.dx = 0; }
}

const mX = new Median(), mY = new Median(), mSize = new Median(3), mPinch = new Median();
const fX = new OneEuro(), fY = new OneEuro(), fSize = new OneEuro(.8, .3);
const filters = [mX, mY, mSize, mPinch, fX, fY, fSize];

let landmarker, video, stream, on = false, lastTime = -1, lastNow = 0;
let grab = null, onFrames = 0, offFrames = 0, lastSeen = 0, state = 'no hand';
let previewUntil = 0, previewPinned = false;

function letGo() {
  if (grab) { dragging = false; handTarget = null; endSpin(); }
  grab = null; onFrames = offFrames = 0;
  $btn.classList.remove('grab');
  filters.forEach((f) => f.reset());
}

/** One camera frame of 21 hand landmarks (or null). */
export function applyGesture(L, now = performance.now()) {
  const dt = clamp((now - (lastNow || now - 33)) / 1000, 1 / 120, .25);
  lastNow = now;
  if (!L) { state = 'no hand'; letGo(); return { state }; }

  const size = fSize.filter(mSize.push(dist(L[0], L[9])), now);
  if (size < T.MIN_HAND) { state = 'come closer'; letGo(); return { state }; }

  // Palm centre is far steadier than fingertips.
  const palm = { x: (L[0].x + L[9].x) / 2, y: (L[0].y + L[9].y) / 2 };
  const p = { x: fX.filter(mX.push(palm.x), now), y: fY.filter(mY.push(palm.y), now) };
  const pinch = mPinch.push(dist(L[4], L[8]) / size);

  // Grab / release with hysteresis, so a borderline pinch doesn't flicker.
  if (!grab) {
    onFrames = pinch < T.PINCH_ON ? onFrames + 1 : 0;
    if (onFrames >= T.FRAMES_ON) {
      grab = { x: p.x, y: p.y, size, zoom: zoomTarget };
      dragging = true; handTarget = { yaw, pitch }; beginSpin();
      $btn.classList.add('grab'); onFrames = offFrames = 0;
    }
  } else {
    offFrames = pinch > T.PINCH_OFF ? offFrames + 1 : 0;
    if (offFrames >= T.FRAMES_OFF) letGo();
  }

  if (!grab) { state = 'ready — pinch to grab'; return { state, pinch }; }

  // Spin: how far your hand has moved since the last frame (the camera image is mirrored).
  let dx = -(p.x - grab.x), dy = p.y - grab.y;
  if (Math.abs(dx) < T.SPIN_DEADBAND) dx = 0;
  if (Math.abs(dy) < T.SPIN_DEADBAND) dy = 0;
  const spinCap = T.SPIN_RATE * dt;
  handTarget.yaw += clamp(dx * T.SPIN, -spinCap, spinCap);
  handTarget.pitch += clamp(dy * T.SPIN, -spinCap, spinCap);
  grab.x = p.x; grab.y = p.y;

  // Size: how much nearer or further your hand is than when you grabbed.
  const wanted = clamp(grab.zoom * Math.pow(size / grab.size, T.ZOOM_POWER), .5, 3);
  const zoomCap = T.ZOOM_RATE * dt;
  zoomTarget = clamp(zoomTarget + clamp(wanted - zoomTarget, -zoomCap, zoomCap), .5, 3);

  state = `holding · ${zoomTarget.toFixed(1)}×`;
  return { state, pinch, grabbing: true };
}

/* ---------- camera preview (press H) ---------- */
function drawPreview(L) {
  if (!$view) return;
  const showing = previewPinned || performance.now() < previewUntil;
  $view.hidden = !showing;
  if (!showing) return;
  const w = $view.width, h = $view.height;
  vctx.clearRect(0, 0, w, h);
  vctx.save(); vctx.translate(w, 0); vctx.scale(-1, 1);
  vctx.globalAlpha = .4; vctx.drawImage(video, 0, 0, w, h); vctx.globalAlpha = 1;
  if (L) {
    vctx.fillStyle = grab ? 'rgba(255,230,150,.95)' : 'rgba(255,196,64,.7)';
    for (const pt of L) vctx.fillRect(pt.x * w - 2, pt.y * h - 2, 4, 4);
    vctx.strokeStyle = grab ? 'rgb(255,225,140)' : 'rgba(255,196,64,.45)';
    vctx.lineWidth = grab ? 3 : 1.5;
    vctx.beginPath(); vctx.moveTo(L[4].x * w, L[4].y * h); vctx.lineTo(L[8].x * w, L[8].y * h); vctx.stroke();
  }
  vctx.restore();
  vctx.fillStyle = grab ? 'rgb(255,225,140)' : 'rgba(255,196,64,.6)';
  vctx.font = '11px Segoe UI, sans-serif';
  vctx.fillText(state, 8, h - 8);
  vctx.fillStyle = 'rgba(255,196,64,.45)';
  vctx.fillText(`orb ${Math.round(window.__fps || 0)} fps · hand ${Math.round(trackFps)} fps`, 8, 14);
}

async function start() {
  try {
    caption('Starting camera…', 2000);
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' } });
    video = Object.assign(document.createElement('video'), { srcObject: stream, muted: true, playsInline: true });
    await video.play();
    if (!landmarker) {
      const files = await FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm');
      landmarker = await HandLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: '/vendor/hand_landmarker.task', delegate: 'GPU' },
        runningMode: 'VIDEO', numHands: 1,
        minHandDetectionConfidence: .5, minHandPresenceConfidence: .5, minTrackingConfidence: .5,
      });
    }
    on = true; $btn.classList.add('on');
    previewUntil = performance.now() + 20_000;         // show what the camera sees while you get the hang of it
    caption('Pinch your thumb and finger to grab the orb. Move to spin, move closer or further to resize. Press H for the camera view.', 7000);
    requestAnimationFrame(loop);
  } catch (e) {
    stop();
    caption(e.name === 'NotAllowedError' ? 'Camera access was blocked.' : 'Camera unavailable: ' + e.message, 4000);
  }
}

function stop() {
  on = false; letGo();
  stream?.getTracks().forEach((t) => t.stop());
  $btn.classList.remove('on', 'grab');
  if ($view) $view.hidden = true;
}

let lastDetect = 0, trackFps = 0, lastLandmarks = null;
function loop() {
  if (!on) return;
  const now = performance.now();
  const due = now - lastDetect >= 1000 / T.TRACK_FPS;
  if (due && video.readyState >= 2 && video.currentTime !== lastTime) {
    lastTime = video.currentTime;
    trackFps += (1000 / Math.max(1, now - lastDetect) - trackFps) * .2;
    lastDetect = now;
    lastLandmarks = landmarker.detectForVideo(video, now).landmarks?.[0] || null;
    if (lastLandmarks) lastSeen = now;
    applyGesture(lastLandmarks, now);
    drawPreview(lastLandmarks);
    window.__handFps = Math.round(trackFps);
  }
  requestAnimationFrame(loop);
}

$btn.onclick = () => (on ? stop() : start());
addEventListener('keydown', (e) => {
  if (e.key?.toLowerCase() !== 'h' || /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)) return;
  previewPinned = !previewPinned;
  caption(previewPinned ? 'Camera view on.' : 'Camera view off.', 1500);
});
window.__applyGesture = applyGesture;
window.__handTuning = T;
