// True Vision Camera — application layer: camera lifecycle, UI state, render loop, capture, saving.
import { SceneAnalyzer, analyzePixels } from './engine/scene.js';
import { decide, distanceAdvice, neutralParams, MODES, PRESETS, DEFAULT_WEIGHTS } from './engine/decision.js';
import { learnStyle } from './engine/aura.js';
import { Renderer, smoothParams } from './engine/renderer.js';
import { captureBurst, saveBlob, canvasToBlob, makeFilename, Recorder } from './engine/capture.js';
import { GROUPS } from './engine/principles.js';
import { initPlatform } from './platform.js';
import { PerfController, TIERS } from './engine/perf.js';
import { defaultFeatures, sanitizeFeatures, featureOn } from './features.js';

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'truevision.v1';
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ---------------------------------------------------------------- state
const DEFAULTS = {
  mode: 'natural', preset: 'natural', capture: 'photo', focal: 24, distTarget: 0.8, trueColor: 0.9, depth: true, natural: true,
  aura: { on: false, dir: 'auto', strength: 0.65, skin: true, style: null },
  res: 2160, prefix: '74', hfov: 65, k1: 0.04, saveRef: false, audio: true, mirrorPreviewOnly: false,
  weights: { ...DEFAULT_WEIGHTS }, theme: 'dark', thirds: false, deviceId: null,
  features: defaultFeatures(),
  focus: { zoom: 4, follow: true, stabilize: true, auto: true, threshold: 0.45 },
  tools: { analyze: false, region: false, particles: false, freq: false },
  freq: { freqRipples: true, freqWaves: true, freqWave: false },
  region: null, palette: 'none', obsMode: 'session', obsRetention: 7, perfTier: 'auto', photoFormat: 'png',
  hidden: { modes: false, panel: false, rail: false, ambient: false, overlay: false },
};

/** Only accept known keys with the expected types from storage (never trust persisted data blindly). */
function sanitize(raw) {
  const s = JSON.parse(JSON.stringify(DEFAULTS));
  if (!raw || typeof raw !== 'object') return s;
  const str = (v, allowed) => (typeof v === 'string' && (!allowed || allowed.includes(v)) ? v : undefined);
  const num = (v, a, b) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, a, b) : undefined);
  const bool = (v) => (typeof v === 'boolean' ? v : undefined);
  s.mode = str(raw.mode, Object.keys(MODES)) ?? s.mode;
  s.preset = str(raw.preset, Object.keys(PRESETS)) ?? s.preset;
  s.capture = str(raw.capture, ['photo', 'video']) ?? s.capture;
  s.focal = num(raw.focal, 18, 85) ?? s.focal; s.distTarget = num(raw.distTarget, 0.3, 1.5) ?? s.distTarget;
  s.trueColor = num(raw.trueColor, 0, 1) ?? s.trueColor; s.depth = bool(raw.depth) ?? s.depth; s.natural = bool(raw.natural) ?? s.natural;
  s.res = num(raw.res, 480, 2160) ?? s.res; s.hfov = num(raw.hfov, 30, 120) ?? s.hfov; s.k1 = num(raw.k1, -0.3, 0.3) ?? s.k1;
  s.saveRef = bool(raw.saveRef) ?? s.saveRef; s.audio = bool(raw.audio) ?? s.audio; s.mirrorPreviewOnly = bool(raw.mirrorPreviewOnly) ?? s.mirrorPreviewOnly;
  s.theme = str(raw.theme, ['dark', 'light']) ?? s.theme; s.thirds = bool(raw.thirds) ?? s.thirds;
  s.prefix = (str(raw.prefix) ?? s.prefix).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16) || '74';
  s.deviceId = typeof raw.deviceId === 'string' && raw.deviceId.length < 200 ? raw.deviceId : null;
  if (raw.weights && typeof raw.weights === 'object') for (const k of Object.keys(DEFAULT_WEIGHTS)) s.weights[k] = num(raw.weights[k], 0, 1) ?? s.weights[k];
  if (raw.aura && typeof raw.aura === 'object') {
    s.aura.on = bool(raw.aura.on) ?? s.aura.on; s.aura.dir = str(raw.aura.dir, ['auto', 'cinematic', 'soft', 'editorial']) ?? s.aura.dir;
    s.aura.strength = num(raw.aura.strength, 0, 1) ?? s.aura.strength; s.aura.skin = bool(raw.aura.skin) ?? s.aura.skin;
    const st = raw.aura.style;
    if (st && typeof st === 'object') s.aura.style = { warmth: num(st.warmth, -1, 1) ?? 0, saturation: num(st.saturation, -1, 1) ?? 0, contrast: num(st.contrast, -1, 1) ?? 0, count: num(st.count, 0, 1000) ?? 0 };
  }
  s.features = sanitizeFeatures(raw.features);
  if (raw.focus && typeof raw.focus === 'object') { s.focus.zoom = num(raw.focus.zoom, 1.5, 12) ?? 4; for (const k of ['follow', 'stabilize', 'auto']) s.focus[k] = bool(raw.focus[k]) ?? s.focus[k]; s.focus.threshold = num(raw.focus.threshold, 0.1, 0.9) ?? 0.45; }
  if (raw.tools && typeof raw.tools === 'object') for (const k of ['analyze', 'region', 'particles', 'freq']) s.tools[k] = bool(raw.tools[k]) ?? false;
  if (raw.freq && typeof raw.freq === 'object') for (const k of Object.keys(s.freq)) s.freq[k] = bool(raw.freq[k]) ?? s.freq[k];
  if (raw.region && typeof raw.region === 'object') { const r = { x: num(raw.region.x, 0, 1), y: num(raw.region.y, 0, 1), w: num(raw.region.w, 0, 1), h: num(raw.region.h, 0, 1) }; s.region = Object.values(r).every((v) => v != null) ? r : null; }
  s.palette = str(raw.palette, ['none', 'thermal-sim', 'night-sim', 'mono']) ?? 'none';
  if (raw.hidden && typeof raw.hidden === 'object') for (const k of Object.keys(s.hidden)) s.hidden[k] = bool(raw.hidden[k]) ?? false;
  s.photoFormat = str(raw.photoFormat, ['png', 'jpeg']) ?? 'png';
  s.perfTier = str(raw.perfTier, ['auto', 'full', 'balanced', 'eco']) ?? 'auto';
  s.obsMode = str(raw.obsMode, ['session', 'private']) ?? 'session'; s.obsRetention = num(raw.obsRetention, 1, 30) ?? 7;
  return s;
}
function load() { try { return sanitize(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')); } catch { return sanitize(null); } }
function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* storage unavailable */ } }
const state = load();

// ---------------------------------------------------------------- elements
const video = $('src'), view = $('view'), viewfinder = $('viewfinder'), statusEl = $('status'), guideEl = $('guide'), guideBox = $('guideBox');
const shutter = $('shutter'), recBadge = $('recBadge'), recTime = $('recTime'), flash = $('flash');
const lastImg = $('lastImg'), lastShot = $('lastShot');
const modeThumbs = [...document.querySelectorAll('[data-thumb]')].map((c) => ({ c, ctx: c.getContext('2d'), kind: c.dataset.thumb }));
const presetThumbs = [...document.querySelectorAll('[data-pthumb]')].map((c) => ({ c, ctx: c.getContext('2d'), kind: c.dataset.pthumb }));
const ambA = $('ambient'), ambB = $('ambient2'); for (const c of [ambA, ambB]) { c.width = 32; c.height = 18; }
const ambCtx = [ambA.getContext('2d'), ambB.getContext('2d')]; let ambFront = 0, ambLast = 0;
const AMB_PERIOD = 1600; document.documentElement.style.setProperty('--amb-period', `${AMB_PERIOD}ms`);
const perf = new PerfController({ start: 'balanced' });

let renderer, analyzer, platform, stream = null, raf = 0, scene = null, smooth = null, decision = null, frameCount = 0, lastThumb = 0, compare = false, busy = false, lastUrl = null, lastLoopT = 0;
const recorder = new Recorder();

// ---------------------------------------------------------------- helpers
function status(text, opts = {}) {
  if (text == null) { statusEl.hidden = true; return; }
  statusEl.hidden = false; statusEl.textContent = text;
  if (opts.retry) { const b = document.createElement('button'); b.className = 'ghost retry'; b.textContent = 'Try again'; b.onclick = () => startCamera(); statusEl.append(document.createElement('br'), b); }
}
function ctl() {
  const f = state.features, proc = featureOn(f, 'processing', 'enabled');
  return { mode: state.mode, preset: state.preset, focal: state.focal, distTarget: state.distTarget, trueColor: state.trueColor, capture: state.capture,
    depth: proc && featureOn(f, 'processing', 'depth') && state.depth, natural: !proc || (featureOn(f, 'processing', 'natural') && state.natural),
    calibration: proc && featureOn(f, 'processing', 'calibration'), exposureColor: proc && featureOn(f, 'processing', 'exposureColor'),
    lowLight: proc && featureOn(f, 'processing', 'lowLight'), palette: featureOn(f, 'presentation', 'palettes') ? state.palette : 'none',
    aura: proc && featureOn(f, 'processing', 'aesthetics') ? state.aura : { on: false } };
}
function cfg() { return { hfov: state.hfov, k1: state.k1, weights: state.weights }; }
function resDims(r) { return r >= 2160 ? [3840, 2160] : r >= 1080 ? [1920, 1080] : [1280, 720]; }
function previewMirror() { return MODES[state.mode].mirror || (state.mirrorPreviewOnly && !recorder.active); }

// ---------------------------------------------------------------- camera
function stopStream() { if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; } cancelAnimationFrame(raf); raf = 0; }

async function startCamera() {
  stopStream();
  status('Starting camera…');
  if (!navigator.mediaDevices?.getUserMedia) return status('This browser cannot access cameras. Use a current Chrome, Edge, Firefox or Safari over https:// or http://localhost.');
  const [w, h] = resDims(state.res);
  const videoC = { width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30 } };
  if (state.deviceId) videoC.deviceId = { exact: state.deviceId }; else videoC.facingMode = 'user';
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: videoC, audio: false });
  } catch (e) {
    if (state.deviceId && e.name === 'OverconstrainedError') { state.deviceId = null; save(); return startCamera(); }
    const msg = e.name === 'NotAllowedError' ? 'Camera access was denied.\nAllow the camera for this site in your browser, then try again.'
      : e.name === 'NotFoundError' ? 'No camera was found on this device.'
      : e.name === 'NotReadableError' ? 'The camera is in use by another application.' : `Could not start the camera: ${e.message || e.name}`;
    return status(msg, { retry: true });
  }
  video.srcObject = stream;
  try { await video.play(); } catch { /* autoplay */ }
  await new Promise((r) => (video.readyState >= 2 ? r() : video.addEventListener('loadeddata', r, { once: true })));
  const track = stream.getVideoTracks()[0];
  await maximizeResolution(track);
  if (track?.getSettings) { const s = track.getSettings(); if (s.deviceId) state.deviceId = s.deviceId; }
  await populateDevices();
  platform.onStream(stream);
  status(null);
  smooth = null; frameCount = 0;
  if (!raf) raf = requestAnimationFrame(loop);
}

/** Browsers often answer an "ideal" request with a modest stream; ask for the device's real maximum (bounded by the chosen resolution). */
async function maximizeResolution(track) {
  if (!track?.getCapabilities || !track.applyConstraints) return;
  try {
    const caps = track.getCapabilities(), cur = track.getSettings(); const [w, h] = resDims(state.res);
    const maxW = Math.min(caps.width?.max || 0, w), maxH = Math.min(caps.height?.max || 0, h);
    if (maxW > (cur.width || 0) + 64 || maxH > (cur.height || 0) + 64) {
      await track.applyConstraints({ width: { ideal: maxW }, height: { ideal: maxH }, frameRate: { ideal: 30 } });
      await new Promise((r) => setTimeout(r, 150));
    }
  } catch { /* keep the stream as delivered */ }
}

async function populateDevices() {
  const sel = $('deviceSel'); sel.textContent = '';
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    devs.forEach((d, i) => { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || `Camera ${i + 1}`; if (d.deviceId === state.deviceId) o.selected = true; sel.append(o); });
    $('flipBtn').disabled = devs.length < 2;
  } catch { /* enumeration unavailable */ }
}

// ---------------------------------------------------------------- render loop
function renderFrame(t, forFile = false) {
  if (!stream || video.readyState < 2 || !video.videoWidth) return false;
  const W = video.videoWidth, H = video.videoHeight;
  const [rw, rh] = forFile ? [W, H] : perf.renderSize(W, H);
  renderer.resize(rw, rh);
  if (frameCount++ % perf.cfg.analysisStride === 0) scene = analyzer.analyze(video, W / H);
  decision = decide(scene, ctl(), cfg());
  const procOff = !featureOn(state.features, 'processing', 'enabled');
  const target = compare || procOff ? { ...neutralParams(decision.params.mirror, W / H), palette: decision.params.palette } : decision.params;
  smooth = smoothParams(smooth, target, state.capture === 'video' ? 0.08 : 0.2);
  const p = (!forFile && previewMirror() !== !!smooth.mirror) ? { ...smooth, mirror: previewMirror() ? 1 : 0 } : smooth;
  renderer.draw(video, p, t / 1000);
  return true;
}

function loop(t) {
  raf = requestAnimationFrame(loop);
  if (busy) return;
  if (lastLoopT) { perf.locked = recorder.active || platform.busy(); if (perf.tick(t - lastLoopT, t)) console.info(`Performance tier → ${perf.cfg.label}`); }
  lastLoopT = t;
  if (!renderFrame(t)) return;
  updateGuide();
  if (recorder.active) { const s = Math.floor(recorder.elapsed); recTime.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }
  platform.frame(t);
  if (t - lastThumb > perf.cfg.thumbMs) { lastThumb = t; drawThumbs(); }
  if (t - ambLast >= AMB_PERIOD) { ambLast = t; drawAmbient(); }
  updateAccent();
  if (!state.hidden.panel && frameCount % 10 === 0) updateAuraReport();
}

function updateGuide() {
  if (guideEl.dataset.hold) return; // a capture note is showing
  const adv = distanceAdvice(decision?.distance ?? null, state.distTarget);
  const hasFace = !!(scene?.face && scene.face.conf > 0.15);
  guideEl.textContent = '';
  const pill = document.createElement('span'); pill.className = `pill ${adv.cls}`; pill.textContent = adv.text; guideEl.append(pill);
  $('distHint').textContent = hasFace && decision?.distance ? adv.text : 'Recommended for natural proportions';
  if (state.thirds && hasFace && smooth && featureOn(state.features, 'presentation', 'faceBox')) {
    const r = viewfinder.getBoundingClientRect(); const A = video.videoWidth / video.videoHeight, B = r.width / r.height;
    const dw = A > B ? r.height * A : r.width, dh = A > B ? r.height : r.width / A; const ox = (r.width - dw) / 2, oy = (r.height - dh) / 2;
    const z = smooth.zoom || 1; let fx = 0.5 + (scene.face.x - 0.5) * z, fy = 0.5 + (scene.face.y - 0.5) * z; if (previewMirror()) fx = 1 - fx;
    const fw = scene.face.w * z, fh = scene.face.h * z;
    guideBox.hidden = false;
    guideBox.style.left = `${ox + (fx - fw / 2) * dw}px`; guideBox.style.top = `${oy + (fy - fh / 2) * dh}px`;
    guideBox.style.width = `${fw * dw}px`; guideBox.style.height = `${fh * dh}px`;
  } else guideBox.hidden = true;
}

const THUMB_FILTERS = { natural: 'none', mirror: 'none', cinematic: 'contrast(1.15) saturate(0.9) sepia(0.12)', portrait: 'contrast(1.05) brightness(1.04)', soft: 'blur(0.6px) contrast(0.95)', studio: 'brightness(1.1) contrast(1.06) sepia(0.05)', film: 'sepia(0.25) contrast(1.08) saturate(0.85)' };
function drawCover(ctx, c, mirror, filter) {
  const vw = video.videoWidth, vh = video.videoHeight; if (!vw) return;
  const s = Math.max(c.width / vw, c.height / vh); const sw = c.width / s, sh = c.height / s; const sx = (vw - sw) / 2, sy = (vh - sh) / 2;
  ctx.save(); ctx.filter = filter || 'none'; if (mirror) { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height); ctx.restore();
}
function drawThumbs() {
  if (!state.hidden.modes) for (const t of modeThumbs) drawCover(t.ctx, t.c, t.kind === 'mirror', THUMB_FILTERS[t.kind]);
  if (!state.hidden.panel) for (const t of presetThumbs) drawCover(t.ctx, t.c, previewMirror(), THUMB_FILTERS[t.kind]);
}
const HIDEABLE = ['modes', 'panel', 'rail', 'ambient', 'overlay'];
function applyHidden() {
  for (const k of HIDEABLE) document.body.classList.toggle(`hide-${k}`, !!state.hidden[k]);
  const any = HIDEABLE.some((k) => state.hidden[k]);
  $('hideBtn').classList.toggle('on', any); $('hideBtn').title = any ? 'Show all panels (H)' : 'Hide panels (H). Hidden panels stop drawing, which saves power and heat.';
  save();
}
function toggleMinimal() { const any = HIDEABLE.some((k) => state.hidden[k]); for (const k of HIDEABLE) state.hidden[k] = !any; applyHidden(); }
function drawAmbient() {
  // Draw the next sample into the back buffer, then swap: the CSS cross-fade lasts exactly one
  // sampling period, so the background glides continuously instead of jumping. Orientation is
  // fixed (never mirrored) so switching modes does not flip the room behind the interface.
  if (!featureOn(state.features, 'presentation', 'ambient') || state.hidden.ambient) return;
  const back = 1 - ambFront; const c = back ? ambB : ambA;
  drawCover(ambCtx[back], c, false);
  (back ? ambB : ambA).classList.add('front'); (back ? ambA : ambB).classList.remove('front'); ambFront = back;
}
function updateAccent() {
  if (!scene || !featureOn(state.features, 'presentation', 'ambient') || state.hidden.ambient) return;
  // Adopt the scene's colour into the UI: one hue + one chroma drive the whole oklch token scale.
  const [r, g, b] = scene.mean; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 80; // house gold when the scene is neutral
  if (d > 0.02) { h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h = (h * 60 + 360) % 360; }
  const sat = mx > 0 ? d / mx : 0;
  const chroma = 0.06 + Math.min(sat, 0.6) * 0.1;
  const blend = Math.min(1, sat * 2.5);
  const dh = ((h - 80 + 540) % 360) - 180; const hue = (80 + dh * blend + 360) % 360;
  // slow exponential smoothing per frame (~2 s time constant at 60 fps): no sudden colour steps
  hueSmooth = hueSmooth == null ? hue : hueSmooth + (((hue - hueSmooth + 540) % 360) - 180) * 0.01;
  chromaSmooth = chromaSmooth == null ? chroma : chromaSmooth + (chroma - chromaSmooth) * 0.01;
  if (frameCount % 6) return; // write CSS variables at ~10 Hz; transitions interpolate between writes
  const root = document.documentElement.style;
  root.setProperty('--h', (((hueSmooth % 360) + 360) % 360).toFixed(1));
  root.setProperty('--c', chromaSmooth.toFixed(3));
  const acc = hslToRgb(hueSmooth, state.theme === 'light' ? 0.55 : 0.6, state.theme === 'light' ? 0.36 : 0.74);
  root.setProperty('--accent-rgb', acc.join(','));
}
let hueSmooth = null, chromaSmooth = null;
function hslToRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}
function updateAuraReport() {
  const el = $('auraReport');
  if (!state.aura.on) { el.textContent = ''; return; }
  if (state.capture === 'video') { el.textContent = 'Adaptive Aura applies to photos only. Switch to PHOTO to use it.'; return; }
  const a = decision?.aura; if (!a) { el.textContent = 'Analysing scene…'; return; }
  el.textContent = `${a.name}: ${a.notes.length ? a.notes.join('; ') : 'balanced grade for this scene'}${state.aura.style ? ` · style learned from ${state.aura.style.count} photo(s)` : ''}.`;
}

// ---------------------------------------------------------------- capture
function flashBadge(text) { if (!featureOn(state.features, 'privacy', 'indicator')) return; recBadge.hidden = false; recTime.textContent = text; setTimeout(() => { if (!recorder.active) recBadge.hidden = true; }, 2500); }
/** Full-resolution still through the ImageCapture API (often higher than the video stream), rendered through the same pipeline. */
async function captureStill() {
  if (typeof ImageCapture === 'undefined' || !stream) return null;
  const track = stream.getVideoTracks()[0]; if (!track || track.readyState !== 'live') return null;
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  let bmp = null;
  try {
    const ic = new ImageCapture(track);
    const caps = await withTimeout(ic.getPhotoCapabilities(), 1500).catch(() => null);
    const opts = caps?.imageWidth?.max ? { imageWidth: caps.imageWidth.max, imageHeight: caps.imageHeight?.max } : {};
    const blob = await withTimeout(ic.takePhoto(opts), 3000);
    bmp = await withTimeout(createImageBitmap(blob), 3000);
    if (bmp.width < video.videoWidth) { console.info(`Still ${bmp.width}×${bmp.height} is not larger than the stream; using the burst`); return null; }
    const p = { ...smooth, aspect: bmp.width / bmp.height };
    if (Math.abs(p.aspect - video.videoWidth / video.videoHeight) > 0.02) p.faceR = 0; // different framing: skip face-local re-projection
    renderer.resize(bmp.width, bmp.height); renderer.draw(bmp, p, performance.now() / 1000, true);
    const out = document.createElement('canvas'); out.width = bmp.width; out.height = bmp.height; out.getContext('2d').drawImage(view, 0, 0);
    return { canvas: out, frames: 1, width: out.width, height: out.height, source: 'still' };
  } catch (e) { console.info(`Still capture unavailable (${e.message || e.name}); using the burst`); return null; }
  finally { bmp?.close?.(); }
}

async function takePhoto() {
  if (busy || !stream || !featureOn(state.features, 'recording', 'photo')) return;
  busy = true; shutter.disabled = true;
  try {
    const now = performance.now();
    const shot = (await captureStill()) || (await captureBurst(view, () => renderFrame(performance.now(), true), 6));
    flash.classList.remove('go'); void flash.offsetWidth; flash.classList.add('go');
    const jpeg = state.photoFormat === 'jpeg';
    const blob = await canvasToBlob(shot.canvas, jpeg ? 'image/jpeg' : 'image/png', jpeg ? 0.95 : undefined);
    const name = makeFilename(state.prefix, state.mode, jpeg ? 'jpg' : 'png');
    saveBlob(blob, name);
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = URL.createObjectURL(blob); lastImg.src = lastUrl; lastImg.hidden = false; lastShot.dataset.name = name;
    if (state.saveRef) {
      const ref = document.createElement('canvas'); ref.width = video.videoWidth; ref.height = video.videoHeight;
      ref.getContext('2d').drawImage(video, 0, 0);
      saveBlob(await canvasToBlob(ref, 'image/png'), makeFilename(state.prefix, `${state.mode}_reference`, 'png'));
    }
    const info = `Saved ${shot.width}×${shot.height} · ${shot.source === 'still' ? 'full-resolution still' : `best of ${shot.frames} frames`} · ${(blob.size / 1048576).toFixed(1)} MB`;
    console.info(`${name}: ${info} in ${(performance.now() - now).toFixed(0)} ms`);
    showNote(info);
  } catch (e) { status(`Could not save the photo: ${e.message}`, { retry: false }); setTimeout(() => status(null), 3000); }
  finally { busy = false; shutter.disabled = false; }
}
let noteTimer = 0;
function showNote(text) { const g = guideEl; g.textContent = ''; const pill = document.createElement('span'); pill.className = 'pill ok'; pill.textContent = text; g.append(pill); g.dataset.hold = '1'; clearTimeout(noteTimer); noteTimer = setTimeout(() => { delete g.dataset.hold; }, 2600); }

let micStream = null, recStarting = false;
/** Open the microphone once and keep it ready so recording starts instantly and never loses audio. */
async function ensureMic() {
  if (!state.audio) return null;
  if (micStream && micStream.active) return micStream;
  try { micStream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { micStream = null; }
  return micStream;
}
function releaseMic() { micStream?.getTracks().forEach((t) => t.stop()); micStream = null; }

async function toggleRecording() {
  if (!stream || recStarting || (!recorder.active && !featureOn(state.features, 'recording', 'video'))) return;
  if (recorder.active) {
    shutter.disabled = true;
    const blob = await recorder.end();
    shutter.classList.remove('rec'); recBadge.hidden = true; shutter.disabled = false;
    if (blob && blob.size) {
      const ext = (recorder.mime || '').includes('mp4') ? 'mp4' : 'webm';
      saveBlob(blob, makeFilename(state.prefix, state.mode, ext));
    }
    return;
  }
  if (typeof MediaRecorder === 'undefined') return status('Video recording is not supported in this browser.', { retry: false });
  recStarting = true; shutter.disabled = true;
  try {
    const audio = await ensureMic();
    recorder.begin(view, audio, 30);
    shutter.classList.add('rec'); recBadge.hidden = !featureOn(state.features, 'privacy', 'indicator'); recTime.textContent = '00:00';
  } catch (e) { status(`Could not start recording: ${e.message}`, { retry: false }); setTimeout(() => status(null), 3000); }
  finally { recStarting = false; shutter.disabled = false; }
}

// ---------------------------------------------------------------- UI wiring
function setMode(m) {
  state.mode = m; save();
  document.querySelectorAll('.mode').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  $('modeSub').textContent = MODES[m].sub;
}
function setPreset(p) { state.preset = p; save(); document.querySelectorAll('.preset').forEach((b) => b.classList.toggle('on', b.dataset.preset === p)); }
function setCapture(c) {
  if (recorder.active) return;
  state.capture = c; save();
  document.querySelectorAll('[data-cap]').forEach((b) => { const on = b.dataset.cap === c; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  if (c === 'video') ensureMic(); else releaseMic();
  shutter.classList.toggle('video', c === 'video'); shutter.title = c === 'video' ? 'Start / stop recording (Space)' : 'Capture (Space)';
  $('auraHint').textContent = c === 'video' && state.aura.on ? 'Inactive in video mode · photos only' : 'Scene-aware color grading · photos only';
}
function setTheme(t) { state.theme = t; save(); document.documentElement.dataset.theme = t; }
function bindRange(id, key, fmt, labelId) {
  const el = $(id), lab = labelId ? $(labelId) : null; el.value = state[key];
  const show = () => { if (lab) lab.textContent = fmt(state[key]); };
  el.addEventListener('input', () => { state[key] = Number(el.value); save(); show(); }); show();
}
function bindCheck(id, get, set) { const el = $(id); el.checked = get(); el.addEventListener('change', () => { set(el.checked); save(); }); }

function initUI() {
  document.documentElement.dataset.theme = state.theme;
  setMode(state.mode); setPreset(state.preset); setCapture(state.capture);
  $('resSel').value = String(state.res);
  document.querySelectorAll('.mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  document.querySelectorAll('.preset').forEach((b) => b.addEventListener('click', () => setPreset(b.dataset.preset)));
  document.querySelectorAll('[data-cap]').forEach((b) => b.addEventListener('click', () => setCapture(b.dataset.cap)));
  $('resSel').addEventListener('change', (e) => { state.res = Number(e.target.value); save(); startCamera(); });
  $('themeBtn').addEventListener('click', () => setTheme(state.theme === 'dark' ? 'light' : 'dark'));
  $('settingsBtn').addEventListener('click', () => { platform.renderDeviceCards(); platform.renderFeatureList(); $('settingsDlg').showModal(); });
  $('infoBtn').addEventListener('click', () => { fillReport(); $('infoDlg').showModal(); });
  $('frameBtn').addEventListener('click', () => { state.thirds = !state.thirds; save(); viewfinder.classList.toggle('thirds', state.thirds); $('frameBtn').classList.toggle('on', state.thirds); });
  viewfinder.classList.toggle('thirds', state.thirds); $('frameBtn').classList.toggle('on', state.thirds);
  $('flipBtn').addEventListener('click', async () => {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput'); if (devs.length < 2) return;
    const i = devs.findIndex((d) => d.deviceId === state.deviceId); state.deviceId = devs[(i + 1) % devs.length].deviceId; save(); startCamera();
  });
  shutter.addEventListener('click', () => (state.capture === 'video' ? toggleRecording() : takePhoto()));
  lastShot.addEventListener('click', () => { if (lastUrl) window.open(lastUrl, '_blank', 'noopener'); });

  bindRange('focal', 'focal', (v) => `${v} mm`, 'focalVal');
  $('focal').addEventListener('input', () => { $('focalHint').textContent = state.focal < 35 ? 'Natural perspective (less distortion)' : state.focal < 60 ? 'Classic portrait rendering' : 'Compressed, flattering telephoto look'; });
  bindRange('dist', 'distTarget', (v) => `${v.toFixed(1)} m`, 'distVal');
  bindRange('trueColor', 'trueColor', (v) => `${Math.round(v * 100)}%`, 'colorVal');
  bindCheck('depth', () => state.depth, (v) => { state.depth = v; state.features.processing.depth = v; });
  bindCheck('natural', () => state.natural, (v) => { state.natural = v; state.features.processing.natural = v; });

  // Adaptive Aura
  const auraBody = $('auraBody');
  bindCheck('aura', () => state.aura.on, (v) => { state.aura.on = v; auraBody.hidden = !v; setCapture(state.capture); });
  auraBody.hidden = !state.aura.on;
  document.querySelectorAll('#auraDir .chip').forEach((b) => { b.classList.toggle('on', b.dataset.dir === state.aura.dir); b.addEventListener('click', () => { state.aura.dir = b.dataset.dir; save(); document.querySelectorAll('#auraDir .chip').forEach((x) => x.classList.toggle('on', x === b)); }); });
  const as = $('auraStr'); as.value = state.aura.strength; $('auraStrVal').textContent = `${Math.round(state.aura.strength * 100)}%`;
  as.addEventListener('input', () => { state.aura.strength = Number(as.value); save(); $('auraStrVal').textContent = `${Math.round(state.aura.strength * 100)}%`; });
  bindCheck('auraSkin', () => state.aura.skin, (v) => (state.aura.skin = v));
  const cmp = $('compareBtn');
  const setCompare = (v) => { compare = v; cmp.classList.toggle('active', v); viewfinder.classList.toggle('compare', v); };
  cmp.addEventListener('pointerdown', () => setCompare(true)); ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => cmp.addEventListener(ev, () => setCompare(false)));
  cmp.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setCompare(true); } });
  cmp.addEventListener('keyup', () => setCompare(false));
  $('learnBtn').addEventListener('click', () => $('learnInput').click());
  $('learnInput').addEventListener('change', async (e) => { await learnFromFiles([...e.target.files]); e.target.value = ''; });
  $('forgetBtn').hidden = !state.aura.style;
  $('forgetBtn').addEventListener('click', () => { state.aura.style = null; save(); $('forgetBtn').hidden = true; });

  // Settings
  $('deviceSel').addEventListener('change', (e) => { state.deviceId = e.target.value; save(); startCamera(); });
  $('prefix').value = state.prefix; $('prefix').addEventListener('input', (e) => { state.prefix = e.target.value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16) || '74'; save(); });
  $('hfov').value = state.hfov; $('hfov').addEventListener('change', (e) => { state.hfov = clamp(Number(e.target.value) || 65, 30, 120); e.target.value = state.hfov; save(); });
  $('k1').value = state.k1; $('k1').addEventListener('change', (e) => { state.k1 = clamp(Number(e.target.value) || 0, -0.3, 0.3); e.target.value = state.k1; save(); });
  bindCheck('saveRef', () => state.saveRef, (v) => { state.saveRef = v; state.features.recording.referenceFrames = v; });
  bindCheck('audio', () => state.audio, (v) => { state.audio = v; state.features.recording.audio = v; if (v && state.capture === 'video') ensureMic(); else releaseMic(); });
  bindCheck('mirrorPreviewOnly', () => state.mirrorPreviewOnly, (v) => (state.mirrorPreviewOnly = v));
  for (const [id, key] of [['wg', 'geometry'], ['wp', 'perception'], ['wq', 'quality'], ['wa', 'artistic']]) {
    const el = $(id), lab = $(id + 'Val'); el.value = state.weights[key]; lab.textContent = `${Math.round(state.weights[key] * 100)}%`;
    el.addEventListener('input', () => { state.weights[key] = Number(el.value); lab.textContent = `${Math.round(state.weights[key] * 100)}%`; save(); });
  }
  $('resetBtn').addEventListener('click', () => { try { localStorage.removeItem(STORAGE_KEY); } catch {} location.reload(); });

  // Keyboard
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea, dialog')) return;
    if (e.code === 'Space') { e.preventDefault(); shutter.click(); }
    else if (e.key === 'm' || e.key === 'M') setMode(state.mode === 'mirror' ? 'natural' : 'mirror');
    else if (e.key === 'v' || e.key === 'V') setCapture('video');
    else if (e.key === 'p' || e.key === 'P') setCapture('photo');
    else if (e.key === 'g' || e.key === 'G') $('frameBtn').click();
    else if (e.key === 'h' || e.key === 'H') toggleMinimal();
    else if ((e.key === 'c' || e.key === 'C') && !e.repeat) setCompare(true);
  });
  document.addEventListener('keyup', (e) => { if (e.key === 'c' || e.key === 'C') setCompare(false); });
  window.addEventListener('pagehide', () => { if (recorder.active) recorder.end(); releaseMic(); stopStream(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && !recorder.active && !platform.busy()) { cancelAnimationFrame(raf); raf = 0; }
    else if (!document.hidden && stream && !raf) { lastLoopT = 0; raf = requestAnimationFrame(loop); }
  });
  $('hideBtn').addEventListener('click', toggleMinimal);
  document.querySelectorAll('[data-hide]').forEach((b) => b.addEventListener('click', () => { state.hidden[b.dataset.hide] = true; applyHidden(); }));
  applyHidden();
  $('perfTier').value = state.perfTier; applyPerf();
  $('photoFormat').value = state.photoFormat; $('photoFormat').addEventListener('change', (e) => { state.photoFormat = e.target.value === 'jpeg' ? 'jpeg' : 'png'; save(); });
  $('perfTier').addEventListener('change', (e) => { state.perfTier = e.target.value; save(); applyPerf(); });
}

function applyPerf() { if (state.perfTier === 'auto') perf.setAuto(); else perf.set(state.perfTier); }

async function learnFromFiles(files) {
  const c = document.createElement('canvas'); c.width = 96; c.height = 54; const ctx = c.getContext('2d', { willReadFrequently: true });
  const stats = [];
  for (const f of files.slice(0, 24)) {
    if (!f.type.startsWith('image/')) continue;
    try {
      const bmp = await createImageBitmap(f);
      ctx.drawImage(bmp, 0, 0, 96, 54); bmp.close?.();
      const img = ctx.getImageData(0, 0, 96, 54);
      const a = analyzePixels(img.data, 96, 54, null);
      let sat = 0; for (let p = 0; p < img.data.length; p += 4) { const r = img.data[p], g = img.data[p + 1], b = img.data[p + 2]; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); sat += mx ? (mx - mn) / mx : 0; }
      stats.push({ warmth: a.warmth, saturation: sat / (96 * 54), contrast: a.contrast });
    } catch { /* unreadable image: skip */ }
  }
  state.aura.style = learnStyle(stats); save(); $('forgetBtn').hidden = !state.aura.style;
}

function fillReport() {
  const r = $('report'); r.textContent = '';
  const rows = decision?.report || [{ label: 'Engine', value: 'waiting for camera', ref: '' }];
  for (const row of rows) { const d = document.createElement('div'); const a = document.createElement('span'); a.textContent = `${row.label}${row.ref ? ` · §${row.ref}` : ''}`; const b = document.createElement('span'); b.textContent = row.value; d.append(a, b); r.append(d); }
  if (decision?.aura?.notes?.length) { const d = document.createElement('div'); d.className = 'wide'; const a = document.createElement('span'); a.textContent = 'Adaptive Aura notes'; const b = document.createElement('span'); b.textContent = decision.aura.notes.join('; '); d.append(a, b); r.append(d); }
  { const d = document.createElement('div'); d.className = 'wide'; const a = document.createElement('span'); a.textContent = 'Performance'; const b = document.createElement('span'); b.textContent = `${perf.cfg.label} tier${perf.auto ? ' (auto)' : ''} · ${perf.ema.toFixed(1)} ms/frame · preview ${view.width}×${view.height}`; d.append(a, b); r.append(d); }
  if (decision) { const d = document.createElement('div'); d.className = 'wide'; const a = document.createElement('span'); a.textContent = 'Priority weights'; const b = document.createElement('span'); b.textContent = Object.entries(decision.weights).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(' · '); d.append(a, b); r.append(d); }
  const m = $('models'); m.textContent = '';
  for (const g of GROUPS) {
    const active = g.id === 'portrait' ? !!(scene?.face) : g.id === 'composition' ? state.thirds : !!scene;
    const d = document.createElement('div'); const s = document.createElement('strong'); s.textContent = `${g.model}. ${g.name} `; const e = document.createElement('em'); e.textContent = active ? 'active' : 'idle'; s.append(e);
    const p = document.createElement('p'); p.textContent = `Principles ${g.range[0]}–${g.range[1]} · understands ${g.understands} · ${g.does}.`; d.append(s, p); m.append(d);
  }
}

// ---------------------------------------------------------------- boot
(function boot() {
  try { renderer = new Renderer(view); } catch (e) { return status(`${e.message}\nTrue Vision needs WebGL to run its rendering pipeline.`); }
  analyzer = new SceneAnalyzer();
  initUI();
  platform = initPlatform({ state, save, video, view, viewfinder, status, flashBadge, getSmooth: () => smooth, getScene: () => scene, previewMirror, getStream: () => stream, getStride: () => perf.cfg.analysisStride, isHidden: (k) => !!state.hidden[k] });
  platform.applyFeatures();
  if (!window.isSecureContext) return status('Camera access needs a secure context.\nOpen this app over https:// or at http://localhost.');
  startCamera();
  // Offline support: all processing is local, so once cached the app needs no network at all.
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { /* offline mode unavailable */ });
})();
