import { drawUniform, uniformsReady } from './uniform.js?v=6';

const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';
// Pose por defecto (normalizada: x,d relativos al ancho; y relativo al alto) = posición del óvalo guía.
const DEFAULT_POSE = { x: 0.5, y: 0.36, d: 0.14, roll: 0 };

const $ = id => document.getElementById(id);
const video = $('video'), view = $('view'), out = $('out');
const vctx = view.getContext('2d'), octx = out.getContext('2d');
const screens = ['start', 'camera', 'result'];

const state = {
  gender: 'm', surname: '', facing: 'environment', mirror: false, stream: null,
  vision: null, files: null, detector: null, imageDetector: null,
  pose: null, lastSeen: 0, lastTs: 0, lum: 0.5, frame: 0, raf: 0, busy: false,
};
const res = { snap: null, base: null, dx: 0, dy: 0, scale: 1, pending: 0, blob: null, blobTimer: 0, ver: 0 };

function show(name) {
  for (const s of screens) $(s).classList.toggle('active', s === name);
}

/* ---------- Detección de rostro ---------- */

async function createDetector(mode) {
  const opts = delegate => ({
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: mode,
    minDetectionConfidence: 0.5,
  });
  try {
    return await state.vision.FaceDetector.createFromOptions(state.files, opts('GPU'));
  } catch {
    return state.vision.FaceDetector.createFromOptions(state.files, opts('CPU'));
  }
}

const detectorReady = (async () => {
  try {
    state.vision = await import(`${MP}/vision_bundle.mjs`);
    state.files = await state.vision.FilesetResolver.forVisionTasks(`${MP}/wasm`);
    state.detector = await createDetector('VIDEO');
  } catch (e) {
    console.warn('Detector de rostro no disponible', e);
  }
})();

function cropRect(vw, vh, ratio = 3 / 4) {
  if (vw / vh > ratio) {
    const sw = vh * ratio;
    return { sx: (vw - sw) / 2, sy: 0, sw, sh: vh };
  }
  const sh = vw / ratio;
  return { sx: 0, sy: (vh - sh) / 2, sw: vw, sh };
}

function bestDetection(result) {
  const list = result?.detections || [];
  let best = null, area = 0;
  for (const d of list) {
    const a = d.boundingBox.width * d.boundingBox.height;
    if (a > area) { area = a; best = d; }
  }
  return best;
}

// Convierte una detección (coords de la fuente) a pose normalizada del recorte.
function toPose(det, src) {
  const kp = det.keypoints;
  if (!kp || kp.length < 2) return null;
  const map = p => {
    let x = (p.x * src.vw - src.sx) / src.sw;
    const y = (p.y * src.vh - src.sy) / src.sh;
    if (src.mirror) x = 1 - x;
    return { x, y };
  };
  let a = map(kp[0]), b = map(kp[1]);
  if (a.x > b.x) [a, b] = [b, a];
  const ar = src.sh / src.sw;
  const dx = b.x - a.x, dy = (b.y - a.y) * ar;
  const eyes = Math.hypot(dx, dy);
  const box = det.boundingBox.width / src.sw;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.max(eyes, box * 0.4), roll: Math.atan2(dy, dx) };
}

function smooth(prev, next) {
  if (!prev || Math.hypot(next.x - prev.x, next.y - prev.y) > prev.d * 1.5) return next;
  const k = 0.4, mix = (a, b) => a + (b - a) * k;
  return { x: mix(prev.x, next.x), y: mix(prev.y, next.y), d: mix(prev.d, next.d), roll: mix(prev.roll, next.roll) };
}

const toPx = (p, W, H) => ({ x: p.x * W, y: p.y * H, d: p.d * W, roll: p.roll });

/* ---------- Composición ---------- */

function sampleLum(c, px, W, H) {
  const s = px.d * 1.6;
  const x = Math.max(0, Math.round(px.x - s / 2)), y = Math.max(0, Math.round(px.y));
  const w = Math.min(W - x, Math.round(s)), h = Math.min(H - y, Math.round(s));
  if (w < 4 || h < 4) return 0.5;
  const data = c.getImageData(x, y, w, h).data;
  let sum = 0, n = 0;
  for (let i = 0; i < data.length; i += 16) {
    sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    n++;
  }
  return sum / n / 255;
}

const layer = document.createElement('canvas');
function paintUniform(c, W, H, pose, lum) {
  if (layer.width !== W || layer.height !== H) { layer.width = W; layer.height = H; }
  const l = layer.getContext('2d');
  l.clearRect(0, 0, W, H);
  drawUniform(l, toPx(pose, W, H), { gender: state.gender, surname: state.surname });
  // oscurece el uniforme en ambientes con poca luz para que no "flote"
  const dark = Math.min(0.4, Math.max(0, (0.5 - lum) * 0.8));
  if (dark > 0) {
    l.globalCompositeOperation = 'source-atop';
    l.fillStyle = `rgba(0,0,0,${dark})`;
    l.fillRect(0, 0, W, H);
    l.globalCompositeOperation = 'source-over';
  }
  c.drawImage(layer, 0, 0);
}

// Franja con la leyenda del evento (se ve en vivo y queda en la foto).
function drawBrand(c, W, H) {
  const h = Math.round(W * 0.12), y = H - h;
  const g = c.createLinearGradient(0, y - h * 0.5, 0, H);
  g.addColorStop(0, 'rgba(7,16,31,0)');
  g.addColorStop(0.35, 'rgba(7,16,31,.8)');
  g.addColorStop(1, 'rgba(7,16,31,.94)');
  c.fillStyle = g;
  c.fillRect(0, y - h * 0.5, W, h * 1.5);
  c.fillStyle = '#e2b845';
  c.fillRect(W * 0.1, y + h * 0.14, W * 0.8, Math.max(1, W * 0.003));

  const parts = [['EXPO 2026', '#f3d27a'], ['  •  ', '#e2b845'], ['TUCUMÁN', '#fff'], ['  •  ', '#e2b845'], ['IESP', '#fff']];
  c.save();
  c.font = `800 ${Math.round(h * 0.34)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  c.textBaseline = 'middle';
  c.textAlign = 'left';
  const total = parts.reduce((t, [str]) => t + c.measureText(str).width, 0);
  const k = Math.min(1, (W * 0.9) / total);
  c.translate(W / 2, y + h * 0.55);
  c.scale(k, k);
  let x = -total / 2;
  for (const [str, col] of parts) {
    c.fillStyle = col;
    c.fillText(str, x, 0);
    x += c.measureText(str).width;
  }
  c.restore();
}

function drawGuide(c, W, H) {
  const p = toPx(DEFAULT_POSE, W, H), d = p.d;
  c.save();
  c.translate(p.x, p.y);
  c.strokeStyle = 'rgba(255,255,255,.92)';
  c.lineWidth = Math.max(2, W * 0.006);
  c.shadowColor = 'rgba(0,0,0,.5)';
  c.shadowBlur = 6;
  c.beginPath();
  c.ellipse(0, -0.1 * d, 1.2 * d, 1.62 * d, 0, 0, Math.PI * 2);
  c.stroke();
  c.setLineDash([W * 0.022, W * 0.016]);
  for (const s of [-1, 1]) {
    c.beginPath();
    c.moveTo(s * 1.0 * d, 1.75 * d);
    c.quadraticCurveTo(s * 2.3 * d, 1.85 * d, s * 2.85 * d, 2.3 * d);
    c.quadraticCurveTo(s * 3.2 * d, 2.7 * d, s * 3.3 * d, H - p.y);
    c.stroke();
  }
  c.restore();
}

/* ---------- Cámara ---------- */

function stopCamera() {
  state.stream?.getTracks().forEach(t => t.stop());
  state.stream = null;
}

async function startCamera() {
  stopCamera();
  $('camError').classList.add('hidden');
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: state.facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
  } catch (e) {
    $('camError').classList.remove('hidden');
    return;
  }
  video.srcObject = state.stream;
  await video.play().catch(() => {});
  const fm = state.stream.getVideoTracks()[0].getSettings().facingMode;
  state.mirror = fm ? fm === 'user' : true;
  state.pose = null;
}

function sizeView() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(Math.min(view.clientWidth, view.clientHeight * 0.75) * dpr);
  if (w && view.width !== w) { view.width = w; view.height = Math.round(w * 4 / 3); }
}

function loop() {
  if (!$('camera').classList.contains('active')) { state.raf = 0; return; }
  state.raf = requestAnimationFrame(loop);
  sizeView();
  const W = view.width, H = view.height;
  if (video.readyState < 2 || !W) return;
  const vw = video.videoWidth, vh = video.videoHeight, crop = cropRect(vw, vh);

  vctx.save();
  if (state.mirror) { vctx.translate(W, 0); vctx.scale(-1, 1); }
  vctx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, W, H);
  vctx.restore();

  const now = performance.now();
  if (state.detector && now > state.lastTs) {
    state.lastTs = now;
    try {
      const det = bestDetection(state.detector.detectForVideo(video, now));
      const p = det && toPose(det, { ...crop, vw, vh, mirror: state.mirror });
      if (p) { state.pose = smooth(state.pose, p); state.lastSeen = now; }
    } catch (e) { /* frame salteado */ }
  }

  const seen = state.pose && now - state.lastSeen < 700;
  if (seen) {
    if (state.frame++ % 10 === 0) state.lum = sampleLum(vctx, toPx(state.pose, W, H), W, H);
    paintUniform(vctx, W, H, state.pose, state.lum);
  } else {
    drawGuide(vctx, W, H);
  }
  drawBrand(vctx, W, H);
  const hint = !state.detector ? 'Ubicá el rostro dentro del óvalo'
    : seen ? '¡Listo! Sacá la foto' : 'Ubicá el rostro dentro del óvalo';
  if ($('hint').textContent !== hint) $('hint').textContent = hint;
}

function startLoop() {
  if (!state.raf) state.raf = requestAnimationFrame(loop);
}

const wait = ms => new Promise(r => setTimeout(r, ms));

async function countdown(n) {
  const el = $('count');
  el.classList.remove('hidden');
  for (let i = n; i > 0; i--) {
    el.textContent = i;
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
    await wait(1000);
  }
  el.classList.add('hidden');
}

async function capture() {
  if (state.busy || video.readyState < 2) return;
  state.busy = true;
  if (state.mirror) await countdown(3);
  const flash = $('flash');
  flash.classList.remove('go');
  void flash.offsetWidth;
  flash.classList.add('go');

  const vw = video.videoWidth, vh = video.videoHeight, crop = cropRect(vw, vh);
  const scale = Math.min(1, 1440 / crop.sh);
  const snap = document.createElement('canvas');
  snap.width = Math.round(crop.sw * scale);
  snap.height = Math.round(crop.sh * scale);
  const c = snap.getContext('2d');
  if (state.mirror) { c.translate(snap.width, 0); c.scale(-1, 1); }
  c.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, snap.width, snap.height);

  const seen = state.pose && performance.now() - state.lastSeen < 700;
  showResult(snap, seen ? { ...state.pose } : { ...DEFAULT_POSE });
  state.busy = false;
}

async function fromGallery(file) {
  if (!file) return;
  const img = await createImageBitmap(file).catch(() => null);
  if (!img) { alert('No se pudo abrir la imagen.'); return; }
  const scale = Math.min(1, 1440 / Math.max(img.width, img.height));
  const snap = document.createElement('canvas');
  snap.width = Math.round(img.width * scale);
  snap.height = Math.round(img.height * scale);
  snap.getContext('2d').drawImage(img, 0, 0, snap.width, snap.height);

  let pose = null;
  await detectorReady;
  if (state.vision) {
    try {
      state.imageDetector ||= await createDetector('IMAGE');
      const det = bestDetection(state.imageDetector.detect(snap));
      const W = snap.width, H = snap.height;
      if (det) pose = toPose(det, { sx: 0, sy: 0, sw: W, sh: H, vw: W, vh: H, mirror: false });
    } catch (e) { console.warn(e); }
  }
  if (!pose) pose = { ...DEFAULT_POSE, y: 0.36 * (snap.width * 4 / 3) / snap.height };
  showResult(snap, pose);
}

/* ---------- Resultado ---------- */

function currentPose() {
  const b = res.base;
  return { x: b.x + res.dx, y: b.y + res.dy, d: b.d * res.scale, roll: b.roll };
}

function renderResult() {
  res.pending = 0;
  const { snap } = res, W = snap.width, H = snap.height;
  if (out.width !== W || out.height !== H) { out.width = W; out.height = H; }
  octx.drawImage(snap, 0, 0);
  const pose = currentPose();
  paintUniform(octx, W, H, pose, sampleLum(octx, toPx(pose, W, H), W, H));
  drawBrand(octx, W, H);
  prepareBlob();
}

function scheduleRender() {
  if (!res.pending) res.pending = requestAnimationFrame(renderResult);
}

function showResult(snap, pose) {
  Object.assign(res, { snap, base: pose, dx: 0, dy: 0, scale: 1 });
  $('size').value = 100;
  show('result');
  renderResult();
}

function fileName() {
  const slug = (state.surname || 'foto').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `uniforme-${slug}.jpg`;
}

const encode = () => new Promise(r => out.toBlob(r, 'image/jpeg', 0.9));
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let canShareFiles = false;

// La foto se codifica apenas se termina de acomodar, así "Guardar" es instantáneo.
function prepareBlob() {
  clearTimeout(res.blobTimer);
  res.blob = null;
  const ver = ++res.ver;
  res.blobTimer = setTimeout(async () => {
    const blob = await encode();
    if (ver === res.ver) res.blob = blob;
  }, 250);
}

const getBlob = async () => res.blob || encode();

function flashLabel(btn, text) {
  const label = btn.querySelector('span'), old = btn.dataset.label ||= label.textContent;
  label.textContent = text;
  clearTimeout(btn._t);
  btn._t = setTimeout(() => { label.textContent = old; }, 1800);
}

async function shareBlob(blob) {
  const file = new File([blob], fileName(), { type: 'image/jpeg' });
  try {
    await navigator.share({ files: [file], title: 'Uniforme Virtual' });
  } catch (e) { /* cancelado */ }
}

async function save() {
  const blob = await getBlob();
  // En iPhone la hoja de compartir tiene "Guardar imagen", que la manda directo a Fotos.
  if (isIOS && canShareFiles) return shareBlob(blob);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName();
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  flashLabel($('saveBtn'), '¡Guardada!');
}

async function share() {
  shareBlob(await getBlob());
}

/* ---------- Vista previa del inicio ---------- */

function drawPreview(canvas, gender) {
  const c = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
  const g = c.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#1d3354');
  g.addColorStop(1, '#0c1a2e');
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);
  // silueta neutra donde va la cara
  const p = { x: W / 2, y: H * 0.36, d: W * 0.15, roll: 0 };
  c.fillStyle = 'rgba(255,255,255,.12)';
  c.beginPath();
  c.ellipse(p.x, p.y + 0.2 * p.d, 1.05 * p.d, 1.45 * p.d, 0, 0, Math.PI * 2);
  c.fill();
  c.fillRect(p.x - 0.6 * p.d, p.y + 1.2 * p.d, 1.2 * p.d, 0.9 * p.d);
  drawUniform(c, p, { gender, surname: state.surname });
}

function renderPreviews() {
  document.querySelectorAll('canvas[data-preview]').forEach(cv => drawPreview(cv, cv.dataset.preview));
}

/* ---------- Eventos ---------- */

function setGender(g) {
  state.gender = g;
  document.querySelectorAll('[data-gender]').forEach(b => {
    const on = b.dataset.gender === g;
    b.classList.toggle('selected', on);
    b.setAttribute('aria-pressed', on);
  });
  if ($('result').classList.contains('active')) scheduleRender();
}

document.querySelectorAll('[data-gender]').forEach(b => b.addEventListener('click', () => setGender(b.dataset.gender)));

$('surname').addEventListener('input', e => {
  state.surname = e.target.value.trim().toUpperCase().slice(0, 16);
  renderPreviews();
});

$('goBtn').addEventListener('click', async () => {
  show('camera');
  startLoop();
  await startCamera();
});

document.querySelectorAll('[data-back]').forEach(b => b.addEventListener('click', () => {
  if ($('result').classList.contains('active') && state.stream) {
    show('camera');
    startLoop();
  } else {
    stopCamera();
    show('start');
  }
}));

$('shotBtn').addEventListener('click', capture);
$('flipBtn').addEventListener('click', () => {
  state.facing = state.facing === 'user' ? 'environment' : 'user';
  startCamera();
});
$('fileInput').addEventListener('change', e => {
  fromGallery(e.target.files[0]);
  e.target.value = '';
});

$('againBtn').addEventListener('click', () => {
  show('camera');
  startLoop();
  if (!state.stream) startCamera();
});
$('saveBtn').addEventListener('click', save);
$('shareBtn').addEventListener('click', share);
$('size').addEventListener('input', e => { res.scale = e.target.value / 100; scheduleRender(); });
$('resetBtn').addEventListener('click', () => {
  Object.assign(res, { dx: 0, dy: 0, scale: 1 });
  $('size').value = 100;
  scheduleRender();
});

// Arrastrar para acomodar el uniforme sobre la foto
let drag = null;
out.addEventListener('pointerdown', e => {
  drag = { x: e.clientX, y: e.clientY };
  out.setPointerCapture(e.pointerId);
});
out.addEventListener('pointermove', e => {
  if (!drag) return;
  res.dx += (e.clientX - drag.x) / out.clientWidth;
  res.dy += (e.clientY - drag.y) / out.clientHeight;
  drag = { x: e.clientX, y: e.clientY };
  scheduleRender();
});
out.addEventListener('pointerup', () => { drag = null; });
out.addEventListener('pointercancel', () => { drag = null; });

try {
  const probe = new File([new Blob()], 'x.jpg', { type: 'image/jpeg' });
  canShareFiles = !!navigator.canShare?.({ files: [probe] });
  if (canShareFiles) $('shareBtn').classList.remove('hidden');
} catch (e) { /* sin share */ }

setGender('m');
uniformsReady.then(renderPreviews, e => console.warn('No se pudo cargar el uniforme', e));
