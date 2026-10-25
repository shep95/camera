// Platform layer: device system, optical intelligence, adaptive focus, observation history,
// frequency seer, multi-camera workspace, screen recorder and the per-feature settings UI.
import { MotionAnalyzer, Tracker, FlickerAnalyzer, FlickerField } from './engine/vision.js';
import { AdaptiveFocus } from './engine/focus.js';
import { ObservationLog } from './engine/observations.js';
import { DeviceManager } from './engine/devices.js';
import { ScreenRecorder } from './engine/screenrec.js';
import { Workspace } from './engine/workspace.js';
import { DOMAINS, FEATURES, featureOn } from './features.js';
import { saveBlob, canvasToBlob, makeFilename } from './engine/capture.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

export function initPlatform(ctx) {
  const { state, save, video, view, viewfinder } = ctx;
  const F = () => state.features;
  const on = (d, k) => featureOn(F(), d, k);

  const analyzer = new MotionAnalyzer(), tracker = new Tracker(), focus = new AdaptiveFocus(), flicker = new FlickerAnalyzer(128), field = new FlickerField(16, 9, 64);
  const obs = new ObservationLog({ mode: state.obsMode, retentionDays: state.obsRetention, maxItems: 200 });
  const devices = new DeviceManager(), screenRec = new ScreenRecorder(), ws = new Workspace();
  const overlay = $('overlay'), octx = overlay.getContext('2d'), focusRail = $('focusRail'), regionBox = $('regionBox'), modeLabel = $('modeLabel');
  let fieldLast = 0, freqTextLast = 0;
  const fcv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(32, 18) : Object.assign(document.createElement('canvas'), { width: 32, height: 18 });
  const fctx = fcv.getContext('2d', { willReadFrequently: true });
  let vision = null, tracks = [], lastT = 0, frameN = 0, lastEventClip = 0, regionCooldown = 0, regionDraw = null, drawer = null, particleTrails = [];
  const winEls = new Map();

  // ------------------------------------------------------------------ geometry helpers
  // viewfinder size is observed, not measured per call: getBoundingClientRect in a per-point helper
  // forced a layout read for every trajectory point on every frame
  let vfW = viewfinder.clientWidth || 1, vfH = viewfinder.clientHeight || 1, overlayDirty = true;
  new ResizeObserver((entries) => { const b = entries[0].contentRect; vfW = b.width || 1; vfH = b.height || 1; overlayDirty = true; }).observe(viewfinder);
  function coverRect() {
    const r = { width: vfW, height: vfH }; const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
    const A = vw / vh, B = r.width / r.height; const dw = A > B ? r.height * A : r.width, dh = A > B ? r.height : r.width / A;
    return { ox: (r.width - dw) / 2, oy: (r.height - dh) / 2, dw, dh, w: r.width, h: r.height };
  }
  let frameRect = null; // one cover rect per frame, shared by every overlay point
  function uvToScreen(x, y) {
    const c = frameRect || coverRect(); const z = ctx.getSmooth()?.zoom || 1; let fx = 0.5 + (x - 0.5) * z, fy = 0.5 + (y - 0.5) * z; if (ctx.previewMirror()) fx = 1 - fx;
    return { x: c.ox + fx * c.dw, y: c.oy + fy * c.dh, sx: c.dw * z, sy: c.dh * z };
  }
  function screenToUv(px, py) {
    const c = coverRect(); const z = ctx.getSmooth()?.zoom || 1; let fx = (px - c.ox) / c.dw, fy = (py - c.oy) / c.dh; if (ctx.previewMirror()) fx = 1 - fx;
    return { x: clamp(0.5 + (fx - 0.5) / z, 0, 1), y: clamp(0.5 + (fy - 0.5) / z, 0, 1) };
  }

  // ------------------------------------------------------------------ per-frame intelligence
  function frame(t) {
    const dt = lastT ? (t - lastT) / 1000 : 1 / 30; lastT = t; frameN++;
    const intel = on('intelligence', 'enabled') && video.readyState >= 2 && video.videoWidth;
    const wantFreq = intel && on('intelligence', 'frequency') && (state.tools.freq || drawer === 'freq');
    const wantMotion = intel && (on('intelligence', 'motion') || on('intelligence', 'objects') || on('intelligence', 'particles') || on('intelligence', 'autoFocus') || on('intelligence', 'region'));
    if (wantFreq && frameN % 2 === 0) sampleFrequency(t);
    if (wantMotion && frameN % ctx.getStride() === 0) {
      vision = analyzer.analyze(video);
      if (!on('processing', 'stabilization')) vision.shift = { dx: 0, dy: 0 };
      if (on('intelligence', 'objects') || on('intelligence', 'autoFocus') || on('intelligence', 'region')) {
        const res = tracker.update(on('intelligence', 'motion') ? vision.blobs : [], dt * 2, vision.shift);
        tracks = res.tracks;
        for (const t of tracks) if (!on('intelligence', 'attention')) t.score = t.hits >= 6 ? 0.5 : 0;
      } else tracks = [];
      if (on('intelligence', 'particles')) {
        particleTrails.push({ t, pts: vision.particles }); if (particleTrails.length > 12) particleTrails.shift();
      } else particleTrails = [];
      if (on('intelligence', 'region') && state.region) checkRegion(t);
    }
    if (intel && on('intelligence', 'autoFocus')) {
      // never auto-magnify the subject's own face: it is already the centre of the view, and a
      // swaying head would otherwise open windows constantly. Manual clicks can still focus on it.
      const face = ctx.getScene?.()?.face;
      // and require real travel: a lamp flickering in place changes brightness, which frame
      // differencing sees as "motion", but nothing is moving
      const travelled = (t) => { const h = t.history; if (h.length < 6) return 0; let mx = 0; for (const q of h) mx = Math.max(mx, Math.hypot(q.x - h[0].x, q.y - h[0].y)); return mx; };
      const exclude = (t) => travelled(t) < 0.04 || (face && face.conf > 0.2 && Math.abs(t.x - face.x) < face.w * 0.85 && Math.abs(t.y - face.y) < face.h * 0.95);
      focus.set({ auto: state.focus.auto, follow: state.focus.follow, stabilize: state.focus.stabilize, zoom: state.focus.zoom, threshold: state.focus.threshold, exclude });
      const events = focus.update(tracks, performance.now());
      for (const e of events) onFocusEvent(e);
    } else if (focus.windows.length) { focus.closeAll(); }
    drawOverlay(); renderFocusWindows();
    if (drawer === 'freq' && t - freqTextLast > 500) { freqTextLast = t; updateFreqText(); }
    if (screenRec.active && frameN % 30 === 0) $('srTime').textContent = fmt(screenRec.elapsed);
    if (ws.recording && frameN % 30 === 0) $('wsStatus').textContent = `Recording ${fmt((performance.now() - ws.recordingSince) / 1000)}`;
  }

  /** Brightness sampling for the frequency seer: a 32×18 luma grid, independent of the analysis tier. */
  function sampleFrequency(t) {
    fctx.drawImage(video, 0, 0, 32, 18); const { data } = fctx.getImageData(0, 0, 32, 18);
    const L = new Float32Array(32 * 18); let sum = 0;
    for (let i = 0, p = 0; i < L.length; i++, p += 4) { const y = (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) / 255; L[i] = y; sum += y; }
    flicker.push(sum / L.length, t); field.push(L, 32, 18, t);
    if (t - fieldLast > 400) { fieldLast = t; field.compute(); }
  }

  function checkRegion(t) {
    const r = state.region; let hit = 0;
    for (const b of vision.blobs) { const ix = Math.max(0, Math.min(b.x + b.w / 2, r.x + r.w) - Math.max(b.x - b.w / 2, r.x)); const iy = Math.max(0, Math.min(b.y + b.h / 2, r.y + r.h) - Math.max(b.y - b.h / 2, r.y)); hit += ix * iy; }
    const frac = hit / Math.max(r.w * r.h, 1e-4);
    regionBox.classList.toggle('active', frac > 0.02);
    if (frac > 0.05 && t - regionCooldown > 4000) {
      regionCooldown = t;
      if (on('observation', 'enabled') && on('observation', 'autoCapture') && on('observation', 'log')) addObservation('region', `activity in monitored region (${Math.round(frac * 100)}% of region)`, { x: r.x + r.w / 2, y: r.y + r.h / 2, size: Math.max(r.w, r.h) }, { region_fraction: frac });
      if (on('intelligence', 'events')) recordEventClip('region');
    }
  }

  // ------------------------------------------------------------------ overlay drawing
  function drawOverlay() {
    const c = coverRect(); frameRect = c; const dpr = Math.min(devicePixelRatio || 1, 2); const W = Math.round(c.w * dpr), H = Math.round(c.h * dpr);
    const want = on('presentation', 'enabled') && on('presentation', 'overlays') && on('intelligence', 'enabled') && !ctx.isHidden?.('overlay')
      && ((state.tools.freq && on('intelligence', 'frequency')) || (state.tools.analyze && on('intelligence', 'objects')) || (state.tools.particles && on('intelligence', 'particles')) || focus.windows.length > 0);
    if (!want) { if (overlayDirty) { octx.setTransform(1, 0, 0, 1, 0, 0); octx.clearRect(0, 0, overlay.width, overlay.height); overlayDirty = false; } frameRect = null; return; }
    if (overlay.width !== W || overlay.height !== H) { overlay.width = W; overlay.height = H; }
    octx.setTransform(dpr, 0, 0, dpr, 0, 0); octx.clearRect(0, 0, c.w, c.h); overlayDirty = true;
    if (state.tools.freq && on('intelligence', 'frequency')) drawFrequency(c);
    const showTracks = state.tools.analyze && on('intelligence', 'objects');
    if (showTracks) for (const tr of tracks) {
      if (tr.hits < 3) continue;
      const p = uvToScreen(tr.x, tr.y); const w = tr.w * p.sx, h = tr.h * p.sy;
      octx.lineWidth = 1.5; octx.strokeStyle = tr.misses ? 'rgba(255,200,120,0.8)' : `rgba(255,255,255,${0.35 + tr.score * 0.6})`;
      octx.setLineDash(tr.misses ? [4, 4] : []); octx.strokeRect(p.x - w / 2, p.y - h / 2, w, h); octx.setLineDash([]);
      octx.fillStyle = 'rgba(0,0,0,0.55)'; const lbl = `#${tr.id} ${tr.state} · S ${tr.score.toFixed(2)}`; octx.font = '11px system-ui, sans-serif'; const tw = octx.measureText(lbl).width + 8;
      octx.fillRect(p.x - w / 2, p.y - h / 2 - 16, tw, 14); octx.fillStyle = '#fff'; octx.fillText(lbl, p.x - w / 2 + 4, p.y - h / 2 - 5);
      if (on('intelligence', 'trajectories') && tr.history.length > 2) {
        octx.beginPath(); tr.history.forEach((hp, i) => { const q = uvToScreen(hp.x, hp.y); if (i) octx.lineTo(q.x, q.y); else octx.moveTo(q.x, q.y); });
        octx.strokeStyle = 'rgba(255,255,255,0.45)'; octx.lineWidth = 1; octx.stroke();
      }
    }
    if (state.tools.particles && on('intelligence', 'particles')) {
      particleTrails.forEach((fr, i) => { const a = (i + 1) / particleTrails.length; octx.fillStyle = `rgba(200,230,255,${0.15 + 0.6 * a})`; for (const pt of fr.pts) { const q = uvToScreen(pt.x, pt.y); octx.beginPath(); octx.arc(q.x, q.y, 1 + a * 1.5, 0, Math.PI * 2); octx.fill(); } });
      octx.fillStyle = 'rgba(0,0,0,0.55)'; octx.fillRect(16, 44, 300, 18); octx.fillStyle = '#dfe9ff'; octx.font = '11px system-ui, sans-serif'; octx.fillText(`particle view · ${vision?.particles.length ?? 0} candidates · visualization, not a particle count`, 22, 57);
    }
    for (const w of focus.windows) { // source region of each focus window
      const r = focus.cropRect(w, video.videoWidth, video.videoHeight); const a = uvToScreen(r.sx / video.videoWidth, r.sy / video.videoHeight); const b = uvToScreen((r.sx + r.size) / video.videoWidth, (r.sy + r.size) / video.videoHeight);
      octx.strokeStyle = w.state === 'lost' ? 'rgba(255,120,100,0.8)' : 'rgba(232,215,168,0.8)'; octx.lineWidth = 1; octx.setLineDash([3, 3]); octx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)); octx.setLineDash([]);
    }
  }

  // ------------------------------------------------------------------ focus windows (presentation layer)
  function renderFocusWindows() {
    const show = on('presentation', 'enabled') && on('presentation', 'focusWindows') && !ctx.isHidden?.('rail');
    for (const [id, we] of winEls) if (!focus.windows.find((w) => w.id === id) || !show) { we.root.remove(); winEls.delete(id); }
    focusRail.hidden = !show || focus.windows.length === 0;
    if (!show) return;
    focus.windows.forEach((w) => {
      let we = winEls.get(w.id);
      if (!we) { we = makeWinEl(w); winEls.set(w.id, we); focusRail.append(we.root); }
      const r = focus.cropRect(w, video.videoWidth, video.videoHeight);
      if ((w.state !== 'lost' || !we.frozen) && frameN % 2 === 0) { // the rail refreshes at half rate to stay cool
        we.cctx.save(); if (ctx.previewMirror()) { we.cctx.translate(we.canvas.width, 0); we.cctx.scale(-1, 1); }
        try { we.cctx.drawImage(video, r.sx, r.sy, r.size, r.size, 0, 0, we.canvas.width, we.canvas.height); } catch { /* frame not ready */ }
        we.cctx.restore(); we.frozen = w.state === 'lost';
      }
      we.label.textContent = `${(w.zoom || focus.opts.zoom).toFixed(1)}× · ${w.state}${w.state === 'lost' ? ' — last observed' : ''}${w.trackId != null ? ` · #${w.trackId}` : ''}`;
      we.root.dataset.state = w.state;
    });
  }
  function makeWinEl(w) {
    const root = el('div', 'focus-win'); const canvas = el('canvas'); canvas.width = 176; canvas.height = 176; const cctx = canvas.getContext('2d');
    const bar = el('div', 'fw-bar'); const label = el('span', 'fw-label', '');
    const pin = el('button', 'fw-btn', '📌'); pin.type = 'button'; pin.title = 'Pin (keep after the target is lost)'; pin.setAttribute('aria-label', 'Pin');
    const zin = el('button', 'fw-btn', '+'); zin.type = 'button'; zin.title = 'Zoom in'; const zout = el('button', 'fw-btn', '−'); zout.type = 'button'; zout.title = 'Zoom out';
    const close = el('button', 'fw-btn', '×'); close.type = 'button'; close.title = 'Close'; close.setAttribute('aria-label', 'Close focus window');
    pin.onclick = () => { w.pinned = !w.pinned; pin.classList.toggle('on', w.pinned); };
    zin.onclick = () => { w.zoom = clamp((w.zoom || focus.opts.zoom) + 1, 1.5, 16); }; zout.onclick = () => { w.zoom = clamp((w.zoom || focus.opts.zoom) - 1, 1.5, 16); };
    close.onclick = () => { focus.close(w.id); };
    bar.append(label, zout, zin, pin, close); root.append(canvas, bar);
    return { root, canvas, cctx, label, frozen: false };
  }

  async function onFocusEvent(e) {
    const w = e.window;
    if (!on('observation', 'enabled') || !on('observation', 'log') || !on('observation', 'autoCapture')) return;
    if (e.kind === 'acquired') {
      await addObservation('acquired', `moving object acquired · focus ${(w.zoom || focus.opts.zoom).toFixed(0)}× · score ${e.track.score.toFixed(2)}`, { x: w.cx, y: w.cy, size: 1 / (w.zoom || focus.opts.zoom) }, { track: e.track.id, score: e.track.score, vx: e.track.vx, vy: e.track.vy });
      if (on('intelligence', 'events')) recordEventClip('acquired');
    } else if (e.kind === 'lost') await addObservation('lost', 'target exited frame or was lost · last observed crop kept', { x: w.cx, y: w.cy, size: 1 / (w.zoom || focus.opts.zoom) }, { track: w.trackId ?? -1 });
    else if (e.kind === 'reacquired') await addObservation('reacquired', 'target reacquired · tracking maintained', { x: w.cx, y: w.cy, size: 1 / (w.zoom || focus.opts.zoom) }, { track: w.trackId ?? -1 });
  }

  /** Store the ORIGINAL observed crop (from the raw video, not the processed view). */
  async function addObservation(kind, label, at, meta = {}) {
    const W = video.videoWidth, H = video.videoHeight; if (!W) return;
    const size = clamp(Math.round(Math.min(W, H) * clamp(at.size, 0.05, 1)), 32, 512);
    const sx = clamp(Math.round(at.x * W - size / 2), 0, W - size), sy = clamp(Math.round(at.y * H - size / 2), 0, H - size);
    const crop = el('canvas'); crop.width = size; crop.height = size; crop.getContext('2d').drawImage(video, sx, sy, size, size, 0, 0, size, size);
    const th = el('canvas'); th.width = 96; th.height = 96; th.getContext('2d').drawImage(crop, 0, 0, 96, 96);
    const [thumb, cropBlob] = await Promise.all([canvasToBlob(th, 'image/jpeg', 0.8), canvasToBlob(crop, 'image/png')]);
    await obs.add({ kind, label, source: 'camera 01', thumb, crop: cropBlob, meta: { ...meta, x: at.x, y: at.y, mode: state.mode } });
  }

  let clipRec = null;
  function recordEventClip(reason) {
    if (!on('recording', 'enabled') || !on('intelligence', 'events') || clipRec || typeof MediaRecorder === 'undefined') return;
    const now = performance.now(); if (now - lastEventClip < 12000) return; lastEventClip = now;
    const stream = view.captureStream(30); const chunks = []; const mime = ['video/webm;codecs=vp9', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
    clipRec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); clipRec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    clipRec.onstop = () => { stream.getTracks().forEach((t) => t.stop()); const b = new Blob(chunks, { type: mime || 'video/webm' }); if (b.size) saveBlob(b, makeFilename(state.prefix, `event_${reason}`, 'webm')); clipRec = null; };
    clipRec.start(500); setTimeout(() => clipRec?.state !== 'inactive' && clipRec.stop(), 8000);
    if (on('privacy', 'indicator')) ctx.flashBadge?.('EVENT CLIP');
  }

  // ------------------------------------------------------------------ drawer
  function openDrawer(name) {
    if (drawer === name) return closeDrawer();
    drawer = name; $('drawer').hidden = false;
    for (const n of ['Focus', 'History', 'Freq']) $(`drawer${n}`).hidden = n.toLowerCase() !== name;
    $('drawerTitle').textContent = name === 'focus' ? 'Adaptive focus' : name === 'history' ? 'Observation history' : 'Frequency seer';
    if (name === 'history') renderHistory();
    updateDock();
  }
  function closeDrawer() { drawer = null; $('drawer').hidden = true; updateDock(); }
  $('drawerClose').addEventListener('click', closeDrawer);

  // focus drawer controls
  $('zoom').value = state.focus.zoom; $('zoomVal').textContent = `${state.focus.zoom.toFixed(1)}×`;
  $('zoom').addEventListener('input', (e) => { state.focus.zoom = Number(e.target.value); $('zoomVal').textContent = `${state.focus.zoom.toFixed(1)}×`; for (const w of focus.windows) w.zoom = state.focus.zoom; save(); });
  for (const [id, key] of [['focusFollow', 'follow'], ['focusStabilize', 'stabilize'], ['focusAuto', 'auto']]) { $(id).checked = state.focus[key]; $(id).addEventListener('change', (e) => { state.focus[key] = e.target.checked; save(); updateDock(); }); }
  $('attn').value = state.focus.threshold; $('attnVal').textContent = `${Math.round(state.focus.threshold * 100)}%`;
  $('attn').addEventListener('input', (e) => { state.focus.threshold = Number(e.target.value); $('attnVal').textContent = `${Math.round(state.focus.threshold * 100)}%`; save(); });
  $('closeFocusWins').addEventListener('click', () => focus.closeAll());

  // history drawer
  $('obsMode').value = state.obsMode; $('obsRetention').value = String(state.obsRetention);
  $('obsMode').addEventListener('change', async (e) => { state.obsMode = e.target.value === 'private' ? 'private' : 'session'; save(); await obs.configure({ mode: state.obsMode }); });
  $('obsRetention').addEventListener('change', async (e) => { state.obsRetention = clamp(Number(e.target.value) || 7, 1, 30); save(); await obs.configure({ retentionDays: state.obsRetention }); });
  $('obsClear').addEventListener('click', () => { if (confirm('Delete all observations?')) obs.clear(); });
  obs.addEventListener('change', () => { if (drawer === 'history') renderHistory(); });
  function renderHistory() {
    const list = $('histList'); list.textContent = '';
    const st = obs.stats(); $('obsStats').textContent = `${st.count} observation${st.count === 1 ? '' : 's'} · ${(st.bytes / 1024).toFixed(0)} KB · ${state.obsMode === 'private' ? 'stored privately in this app (not in your photo folders)' : 'session memory only, cleared when the app closes'}`;
    for (const it of [...obs.items].reverse()) {
      const li = el('li', 'hist-item'); const img = el('img'); img.alt = ''; if (it.thumbUrl) img.src = it.thumbUrl;
      const body = el('div'); body.append(el('strong', null, it.label), el('small', null, `${it.source} · ${new Date(it.t).toLocaleTimeString()} · ${it.kind}`));
      const acts = el('div', 'hist-acts');
      const exp = el('button', 'fw-btn', '↓'); exp.type = 'button'; exp.title = 'Export original crop (saves a file with the 74 mark)'; exp.onclick = () => { if (it.crop) saveBlob(it.crop, makeFilename(state.prefix, `observation_${it.kind}`, 'png', new Date(it.t))); };
      const del = el('button', 'fw-btn', '×'); del.type = 'button'; del.title = 'Delete'; del.onclick = () => obs.remove(it.id);
      acts.append(exp, del); li.append(img, body, acts); list.append(li);
    }
    if (!obs.items.length) list.append(el('li', 'muted', 'No observations yet. Significant moving details, lost targets and region activity appear here.'));
  }

  // frequency seer: an overlay on the image, not a graph. Ripples mark where brightness oscillates
  // (ring rate = measured Hz, colour = frequency); wave lines carry the dominant frequencies
  // (wavelength and travel speed follow the measured rate). Everything drawn is labelled.
  const hzColor = (hz, nyq, a = 0.9) => `hsl(${Math.round(35 + 180 * clamp(hz / Math.max(nyq, 1), 0, 1))} 90% 65% / ${a})`;
  function drawFrequency(c) {
    const res = field.result; const now = performance.now() / 1000;
    const cx = octx; cx.save();
    if ($('freqWave').checked) { // illustrative interference pattern, clearly flagged
      cx.globalAlpha = 0.18; cx.strokeStyle = 'rgba(232,215,168,1)'; cx.lineWidth = 1;
      for (let i = 0; i < 14; i++) { cx.beginPath(); for (let x = 0; x <= c.w; x += 8) { const y = (i + 0.5) * c.h / 14 + Math.sin(x / 36 + now * 1.3 + i) * 9 + Math.sin(x / 11 - now * 2.1) * 4; x ? cx.lineTo(x, y) : cx.moveTo(x, y); } cx.stroke(); }
      cx.globalAlpha = 1; cx.fillStyle = 'rgba(0,0,0,0.55)'; cx.fillRect(c.w - 262, c.h - 34, 250, 18); cx.fillStyle = '#e8d7a8'; cx.font = '11px system-ui, sans-serif'; cx.fillText('ILLUSTRATIVE pattern — not a measurement', c.w - 256, c.h - 21);
    }
    if (!res) { cx.restore(); return; }
    const nyq = res.nyquist;
    if ($('freqRipples').checked) {
      const strong = res.cells.filter((e) => e.mag > 0.003 && e.snr > 2.5).sort((a, b) => b.mag - a.mag).slice(0, 24);
      const maxMag = strong[0]?.mag || 1;
      for (const e of strong) {
        const p = uvToScreen((e.c + 0.5) / field.cols, (e.r + 0.5) / field.rows); const R = Math.min(c.w, c.h) * (0.05 + 0.06 * e.mag / maxMag);
        const cyc = (now * e.hz + e.phase / (2 * Math.PI)) % 1;
        for (let k = 0; k < 3; k++) { const f = (cyc + k / 3) % 1; const r = f * R; cx.beginPath(); cx.arc(p.x, p.y, r, 0, Math.PI * 2); cx.strokeStyle = hzColor(e.hz, nyq, (1 - f) * 0.8 * (0.4 + 0.6 * e.mag / maxMag)); cx.lineWidth = 1.5; cx.stroke(); }
      }
      strong.slice(0, 3).forEach((e) => { const p = uvToScreen((e.c + 0.5) / field.cols, (e.r + 0.5) / field.rows); const lbl = `${e.hz.toFixed(1)} Hz`; cx.font = '11px system-ui, sans-serif'; const w = cx.measureText(lbl).width + 8; cx.fillStyle = 'rgba(0,0,0,0.6)'; cx.fillRect(p.x + 8, p.y - 18, w, 15); cx.fillStyle = hzColor(e.hz, nyq, 1); cx.fillText(lbl, p.x + 12, p.y - 6); });
    }
    if ($('freqWaves').checked) {
      const sp = flicker.spectrum();
      if (sp) {
        const peaks = sp.bins.filter((b, i, arr) => b.mag > 0.0025 && (i === 0 || b.mag >= arr[i - 1].mag) && (i === arr.length - 1 || b.mag >= arr[i + 1].mag)).sort((a, b) => b.mag - a.mag).slice(0, 3);
        const maxMag = peaks[0]?.mag || 1; const y0 = c.h * 0.78;
        peaks.forEach((b, i) => {
          const lambda = Math.max(26, c.w / (3 + b.hz * 3)); const amp = 5 + 22 * (b.mag / maxMag); const yb = y0 + i * 26;
          cx.beginPath(); for (let x = 0; x <= c.w; x += 3) { const y = yb + Math.sin((x / lambda) * 2 * Math.PI - now * b.hz * 2 * Math.PI) * amp; x ? cx.lineTo(x, y) : cx.moveTo(x, y); }
          cx.strokeStyle = hzColor(b.hz, nyq, 0.85); cx.lineWidth = i === 0 ? 2 : 1.25; cx.stroke();
          const lbl = `${b.hz.toFixed(1)} Hz · measured`; cx.font = '11px system-ui, sans-serif'; cx.fillStyle = 'rgba(0,0,0,0.6)'; cx.fillRect(14, yb - amp - 20, cx.measureText(lbl).width + 8, 15); cx.fillStyle = hzColor(b.hz, nyq, 1); cx.fillText(lbl, 18, yb - amp - 8);
        });
      }
    }
    const legend = `frequency seer · measured (optical) · ${res.fps.toFixed(0)} fps → ≤ ${nyq.toFixed(1)} Hz${res.dominant ? ` · dominant ${res.dominant.hz.toFixed(1)} Hz` : ' · no dominant oscillation'}`;
    cx.font = '11px system-ui, sans-serif'; const lw = cx.measureText(legend).width + 10; cx.fillStyle = 'rgba(0,0,0,0.6)'; cx.fillRect(c.w - lw - 14, c.h - 58, lw, 18); cx.fillStyle = '#dfe9ff'; cx.fillText(legend, c.w - lw - 9, c.h - 45);
    cx.restore();
  }
  function updateFreqText() {
    const res = field.result;
    if (!res) { $('freqText').textContent = 'Collecting samples…'; return; }
    const d = res.dominant;
    $('freqText').textContent = `measured (optical): ${d ? `strongest oscillation ≈ ${d.hz.toFixed(1)} Hz at column ${d.c + 1}, row ${d.r + 1}` : 'no cell shows a dominant oscillation above noise'} · sampling ${res.fps.toFixed(1)} fps → Nyquist ${res.nyquist.toFixed(1)} Hz · ${res.samples} samples per cell.`;
  }
  for (const id of ['freqRipples', 'freqWaves', 'freqWave']) { $(id).checked = state.freq[id]; $(id).addEventListener('change', (e) => { state.freq[id] = e.target.checked; save(); }); }

  // ------------------------------------------------------------------ dock
  const PALETTES = ['none', 'thermal-sim', 'night-sim', 'mono'];
  const dockBtns = { dockFocus: () => { if (!on('intelligence', 'autoFocus')) return toast('Adaptive focus is switched off in Settings.'); openDrawer('focus'); },
    dockAnalyze: () => { state.tools.analyze = !state.tools.analyze; save(); updateDock(); },
    dockRegion: () => { state.tools.region = !state.tools.region; if (!state.tools.region) { state.region = null; regionBox.hidden = true; } save(); updateDock(); },
    dockParticles: () => { state.tools.particles = !state.tools.particles; save(); updateDock(); },
    dockFreq: () => { if (!on('intelligence', 'frequency')) return toast('Frequency seer is switched off in Settings.'); state.tools.freq = !state.tools.freq; save(); if (state.tools.freq) openDrawer('freq'); else if (drawer === 'freq') closeDrawer(); updateDock(); },
    dockHistory: () => openDrawer('history'),
    dockWorkspace: () => openWorkspace(), dockScreen: () => openScreenRec(),
    dockPalette: () => { if (!on('presentation', 'palettes')) return toast('Palettes are switched off in Settings.'); state.palette = PALETTES[(PALETTES.indexOf(state.palette) + 1) % PALETTES.length]; save(); updateDock(); } };
  for (const [id, fn] of Object.entries(dockBtns)) $(id).addEventListener('click', fn);
  function updateDock() {
    const set = (id, onState, enabled = true) => { const b = $(id); b.classList.toggle('on', !!onState); b.disabled = !enabled; b.hidden = false; };
    set('dockFocus', drawer === 'focus' || (on('intelligence', 'autoFocus') && state.focus.auto), on('intelligence', 'enabled') && on('intelligence', 'autoFocus'));
    set('dockAnalyze', state.tools.analyze, on('intelligence', 'enabled') && on('intelligence', 'objects'));
    set('dockRegion', state.tools.region, on('intelligence', 'enabled') && on('intelligence', 'region'));
    set('dockParticles', state.tools.particles, on('intelligence', 'enabled') && on('intelligence', 'particles'));
    set('dockFreq', state.tools.freq, on('intelligence', 'enabled') && on('intelligence', 'frequency'));
    set('dockHistory', drawer === 'history', on('observation', 'enabled') && on('observation', 'log'));
    set('dockWorkspace', !$('workspace').hidden, on('device', 'enabled') && on('device', 'multiCamera'));
    set('dockScreen', !$('screenRec').hidden || screenRec.active, on('recording', 'enabled') && on('recording', 'screen') && on('device', 'screenSource'));
    set('dockPalette', state.palette !== 'none', on('presentation', 'enabled') && on('presentation', 'palettes'));
    if (!on('presentation', 'palettes')) state.palette = 'none';
    viewfinder.classList.toggle('region-mode', state.tools.region);
    const pal = state.palette !== 'none' ? ` · ${state.palette.replace('-sim', '-style palette')} — SIMULATED, not a measurement` : '';
    const ll = on('processing', 'lowLight') ? ' · computational low-light (software)' : '';
    modeLabel.textContent = `visible light · ${on('processing', 'enabled') ? 'processed' : 'unprocessed'}${ll}${pal}`;
    modeLabel.classList.toggle('warn', state.palette !== 'none');
  }

  // click to focus / drag to draw region
  viewfinder.addEventListener('pointerdown', (e) => {
    if (document.body.classList.contains('idle')) return; // the first tap on a faded view only wakes the controls
    if (e.target.closest('button, select, .drawer, .focus-win, .dock, .vf-top')) return;
    const r = viewfinder.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top;
    if (state.tools.region && on('intelligence', 'region')) { regionDraw = { x0: px, y0: py }; viewfinder.setPointerCapture(e.pointerId); return; }
    if (on('intelligence', 'enabled') && on('intelligence', 'autoFocus')) {
      const uv = screenToUv(px, py); const near = tracks.find((t) => t.hits >= 3 && Math.hypot(t.x - uv.x, t.y - uv.y) < 0.08);
      const w = focus.open({ trackId: near ? near.id : null, cx: uv.x, cy: uv.y, manual: true });
      if (on('observation', 'autoCapture') && on('observation', 'log') && on('observation', 'enabled')) addObservation('manual', near ? `manual focus on tracked target #${near.id}` : 'manual focus on static region', { x: uv.x, y: uv.y, size: 1 / (w.zoom || 4) }, { manual: true });
    }
  });
  viewfinder.addEventListener('pointermove', (e) => {
    if (!regionDraw) return; const r = viewfinder.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top;
    const x = Math.min(px, regionDraw.x0), y = Math.min(py, regionDraw.y0), w = Math.abs(px - regionDraw.x0), h = Math.abs(py - regionDraw.y0);
    regionBox.hidden = false; Object.assign(regionBox.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` }); regionDraw.last = { x, y, w, h };
  });
  const endRegion = () => { if (!regionDraw) return; const l = regionDraw.last; regionDraw = null; if (!l || l.w < 10 || l.h < 10) { regionBox.hidden = true; state.region = null; save(); return; }
    const a = screenToUv(l.x, l.y), b = screenToUv(l.x + l.w, l.y + l.h); state.region = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }; save(); };
  viewfinder.addEventListener('pointerup', endRegion); viewfinder.addEventListener('pointercancel', endRegion);
  function placeRegionBox() { if (!state.region || !state.tools.region) { regionBox.hidden = true; return; } const a = uvToScreen(state.region.x, state.region.y), b = uvToScreen(state.region.x + state.region.w, state.region.y + state.region.h); regionBox.hidden = false; Object.assign(regionBox.style, { left: `${Math.min(a.x, b.x)}px`, top: `${Math.min(a.y, b.y)}px`, width: `${Math.abs(b.x - a.x)}px`, height: `${Math.abs(b.y - a.y)}px` }); }
  setInterval(() => { if (!regionDraw) placeRegionBox(); }, 500);

  // ------------------------------------------------------------------ workspace
  const wsPanel = $('workspace'), wsGrid = $('wsGrid');
  function openWorkspace() { if (!on('device', 'multiCamera')) return toast('The multi-camera workspace is switched off in Settings.'); wsPanel.hidden = false; refreshWsDevices(); renderWs(); updateDock(); }
  $('wsClose').addEventListener('click', () => { wsPanel.hidden = true; updateDock(); });
  function refreshWsDevices() { const sel = $('wsDevice'); sel.textContent = ''; devices.videoInputs().forEach((d, i) => { const o = el('option', null, d.label || `Camera ${i + 1}`); o.value = d.deviceId; sel.append(o); }); }
  $('wsAddCam').addEventListener('click', async () => { try { await ws.addCamera($('wsDevice').value, $('wsDevice').selectedOptions[0]?.textContent); } catch (e) { toast(e.message); } });
  $('wsAddPrimary').addEventListener('click', () => { const s = ctx.getStream(); if (!s) return toast('The primary camera is not running.'); try { ws.addStream(s.clone(), 'camera', 'primary feed', state.deviceId, true); } catch (e) { toast(e.message); } });
  $('wsAddScreen').addEventListener('click', async () => { if (!on('device', 'screenSource')) return toast('Desktop sources are switched off in Settings.'); try { await ws.addScreen(); } catch (e) { if (e.name !== 'NotAllowedError') toast(e.message); } });
  $('wsLayout').addEventListener('change', (e) => { ws.layout = e.target.value; wsGrid.dataset.layout = ws.layout; });
  $('wsRecord').addEventListener('click', async () => {
    if (!on('recording', 'workspace') || !on('recording', 'enabled')) return toast('Workspace recording is switched off in Settings.');
    if (ws.recording) { const outs = await ws.stopRecording(); for (const o of outs) if (o.blob.size) saveBlob(o.blob, makeFilename(state.prefix, o.name, 'webm')); $('wsRecord').textContent = 'Record'; $('wsStatus').textContent = `Saved ${outs.length} file(s)`; return; }
    if (!ws.tiles.some((t) => t.record)) return toast('Add a source and tick "record" first.');
    try { ws.startRecording({ mode: $('wsRecMode').value }); $('wsRecord').textContent = 'Stop'; } catch (e) { toast(e.message); }
  });
  ws.addEventListener('change', renderWs);
  function renderWs() {
    wsGrid.textContent = ''; wsGrid.dataset.layout = ws.layout;
    if (!ws.tiles.length) { wsGrid.append(el('p', 'muted ws-empty', 'No sources yet. Add a camera, the primary feed or a screen. Tiles represent device sources; each one is an independent stream on a shared clock.')); return; }
    ws.tiles.forEach((t, i) => {
      const tile = el('div', 'ws-tile'); tile.draggable = true; tile.dataset.id = t.id; if (ws.maximized === t.id) tile.classList.add('max');
      tile.append(t.video);
      const bar = el('div', 'ws-bar'); const m = devices.manifest(t.deviceId);
      bar.append(el('span', 'ws-name', `${String(i + 1).padStart(2, '0')} · ${t.label}`), el('span', 'ws-kind', t.kind === 'screen' ? 'desktop source' : (m?.modality.guess || 'visible light')));
      const rec = el('label', 'chk inline'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = t.record; cb.onchange = () => { t.record = cb.checked; }; rec.append(cb, document.createTextNode(' record'));
      const mx = el('button', 'fw-btn', ws.maximized === t.id ? '▣' : '⤢'); mx.type = 'button'; mx.title = 'Maximize'; mx.onclick = () => { ws.maximized = ws.maximized === t.id ? null : t.id; renderWs(); };
      const rm = el('button', 'fw-btn', '×'); rm.type = 'button'; rm.title = 'Remove'; rm.onclick = () => ws.remove(t.id);
      bar.append(rec, mx, rm); tile.append(bar);
      tile.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(t.id)); e.dataTransfer.effectAllowed = 'move'; });
      tile.addEventListener('dragover', (e) => { e.preventDefault(); tile.classList.add('over'); }); tile.addEventListener('dragleave', () => tile.classList.remove('over'));
      tile.addEventListener('drop', (e) => { e.preventDefault(); tile.classList.remove('over'); const id = Number(e.dataTransfer.getData('text/plain')); if (Number.isInteger(id) && id !== t.id) ws.move(id, i); });
      wsGrid.append(tile);
    });
  }

  // ------------------------------------------------------------------ screen recorder
  const srPanel = $('screenRec');
  function openScreenRec() { if (!on('recording', 'screen') || !on('device', 'screenSource')) return toast('Desktop recording is switched off in Settings.'); srPanel.hidden = false; updateDock(); }
  $('srClose').addEventListener('click', () => { srPanel.hidden = true; updateDock(); });
  $('srSelect').addEventListener('click', async () => {
    try { const info = await screenRec.selectSource({ systemAudio: $('srSys').checked }); $('srHint').hidden = true; if (!screenRec.canvas.isConnected) $('srPreview').append(screenRec.canvas); $('srRecord').disabled = false; toast(`Source: ${info.label} ${info.width}×${info.height}${info.hasAudio ? ' · system audio' : ' · no system audio offered'}`); }
    catch (e) { if (e.name !== 'NotAllowedError') toast(e.message); }
  });
  screenRec.addEventListener('sourceended', () => { $('srRecord').disabled = true; $('srHint').hidden = false; });
  $('srOverlay').addEventListener('change', (e) => { screenRec.overlay.enabled = e.target.checked; });
  for (const [gid, key] of [['srShape', 'shape'], ['srSize', 'size']]) $(gid).querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => { screenRec.overlay[key] = b.dataset.v; $(gid).querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === b)); }));
  $('srOpacity').addEventListener('input', (e) => { screenRec.overlay.opacity = Number(e.target.value); $('srOpVal').textContent = `${Math.round(screenRec.overlay.opacity * 100)}%`; });
  // drag the overlay in the preview with corner snapping
  let srDrag = null;
  screenRec.canvas.addEventListener('pointerdown', (e) => { const b = screenRec.lastBox; if (!b) return; const r = screenRec.canvas.getBoundingClientRect(); const u = (e.clientX - r.left) / r.width, v = (e.clientY - r.top) / r.height; if (u >= b.x && u <= b.x + b.w && v >= b.y && v <= b.y + b.h) { srDrag = { u, v, x: screenRec.overlay.x, y: screenRec.overlay.y, w: b.w, h: b.h }; screenRec.canvas.setPointerCapture(e.pointerId); } });
  screenRec.canvas.addEventListener('pointermove', (e) => { if (!srDrag) return; const r = screenRec.canvas.getBoundingClientRect(); const u = (e.clientX - r.left) / r.width, v = (e.clientY - r.top) / r.height; screenRec.overlay.x = clamp(srDrag.x + (u - srDrag.u) / (1 - srDrag.w), 0, 1); screenRec.overlay.y = clamp(srDrag.y + (v - srDrag.v) / (1 - srDrag.h), 0, 1); });
  const srEnd = () => { if (!srDrag) return; srDrag = null; const o = screenRec.overlay; for (const k of ['x', 'y']) { if (o[k] < 0.06) o[k] = 0.03; else if (o[k] > 0.94) o[k] = 0.97; } };
  screenRec.canvas.addEventListener('pointerup', srEnd); screenRec.canvas.addEventListener('pointercancel', srEnd);
  $('srRecord').addEventListener('click', async () => {
    if (screenRec.active) { const blob = await screenRec.stop(); $('srRecord').textContent = 'Record'; $('srPause').disabled = true; $('srPause').textContent = 'Pause'; if (blob?.size) saveBlob(blob, makeFilename(state.prefix, 'screen', (screenRec.mime || '').includes('mp4') ? 'mp4' : 'webm')); updateDock(); return; }
    try { await screenRec.start({ mic: $('srMic').checked && on('recording', 'audio'), sourceCanvas: view }); $('srRecord').textContent = 'Stop'; $('srPause').disabled = false; updateDock(); } catch (e) { toast(e.message); }
  });
  $('srPause').addEventListener('click', () => { if (screenRec.state === 'paused') { screenRec.resume(); $('srPause').textContent = 'Pause'; } else { screenRec.pause(); $('srPause').textContent = 'Resume'; } });

  // ------------------------------------------------------------------ settings: devices + features
  function renderDeviceCards() {
    const box = $('deviceCards'); box.textContent = '';
    if (!on('device', 'discovery')) { box.append(el('p', 'muted', 'Camera discovery is switched off.')); return; }
    const cams = devices.videoInputs(); if (!cams.length) box.append(el('p', 'muted', 'No cameras found (labels appear after camera permission is granted).'));
    cams.forEach((d, i) => {
      const m = devices.manifest(d.deviceId) || devices.blankManifest(d.deviceId); const card = el('div', 'device-card');
      card.append(el('strong', null, d.label || `Camera ${i + 1}`), el('span', 'muted', `modality: ${m.modality.guess}${m.modality.verified ? '' : ' (unverified)'} · ${m.transport}`));
      card.append(el('span', 'muted', `reported: ${m.reported ? `${m.reported.width} × ${m.reported.height} @ ${m.reported.frameRate} fps · controls: ${m.reported.controls.join(', ') || 'none'}` : 'nothing yet'}`));
      card.append(el('span', 'muted', `verified: ${m.verified.resolutions.join(', ') || 'not tested'}${m.verified.controls.length ? ` · ${m.verified.controls.join(', ')}` : ''}`));
      const acts = el('div', 'hist-acts'); const v = el('button', 'ghost sm', 'Verify'); v.type = 'button'; v.disabled = !on('device', 'verify'); v.onclick = async () => { v.disabled = true; v.textContent = 'Testing…'; await devices.verify(d.deviceId); renderDeviceCards(); };
      const ex = el('button', 'ghost sm', 'Manifest'); ex.type = 'button'; ex.onclick = () => { const { modality, ...rest } = m; saveBlob(new Blob([JSON.stringify({ ...rest, sensor_modalities: [modality.guess], modality_note: modality.note }, null, 2)], { type: 'application/json' }), makeFilename(state.prefix, 'manifest', 'json')); };
      acts.append(v, ex); card.append(acts); box.append(card);
    });
  }
  function renderFeatureList() {
    const box = $('featureList'); box.textContent = '';
    for (const d of DOMAINS) {
      const sec = el('details', 'feature-domain'); sec.open = false; const sum = el('summary'); const master = mkSwitch(F()[d.id].enabled, (v) => { F()[d.id].enabled = v; save(); applyFeatures(); renderFeatureList(); });
      sum.append(el('span', 'fd-name', d.name), master.root); sec.append(sum, el('p', 'muted', d.desc));
      for (const [k, def] of Object.entries(FEATURES[d.id])) {
        if (k === 'enabled') continue; const row = el('div', 'feature-row'); const locked = d.id === 'privacy' && (k === 'faceId' || k === 'localOnly');
        const sw = mkSwitch(F()[d.id][k], (v) => { F()[d.id][k] = v; save(); applyFeatures(); }, locked || !F()[d.id].enabled);
        const txt = el('div'); txt.append(el('strong', null, def[1]), el('small', null, def[2])); row.append(txt, sw.root); sec.append(row);
      }
      box.append(sec);
    }
  }
  function mkSwitch(checked, onChange, disabled = false) { const root = el('label', 'switch'); const i = el('input'); i.type = 'checkbox'; i.checked = checked; i.disabled = disabled; i.addEventListener('change', () => onChange(i.checked)); i.addEventListener('click', (e) => e.stopPropagation()); root.addEventListener('click', (e) => e.stopPropagation()); root.append(i, el('i')); return { root, input: i }; }
  function applyFeatures() {
    const f = F();
    // mirror the processing switches into the classic panel toggles
    $('depth').checked = f.processing.depth; $('natural').checked = f.processing.natural; state.depth = f.processing.depth; state.natural = f.processing.natural;
    if (!featureOn(f, 'processing', 'aesthetics') && state.aura.on) { state.aura.on = false; $('aura').checked = false; $('auraBody').hidden = true; }
    state.saveRef = featureOn(f, 'recording', 'referenceFrames'); $('saveRef').checked = state.saveRef;
    state.audio = featureOn(f, 'recording', 'audio'); $('audio').checked = state.audio;
    $('shutter').disabled = !featureOn(f, 'recording', 'enabled') || !(state.capture === 'video' ? featureOn(f, 'recording', 'video') : featureOn(f, 'recording', 'photo'));
    $('frameBtn').disabled = !featureOn(f, 'presentation', 'enabled');
    if (!featureOn(f, 'intelligence', 'autoFocus')) focus.closeAll();
    if (!featureOn(f, 'intelligence', 'region')) { state.tools.region = false; }
    if (!featureOn(f, 'device', 'multiCamera') && !wsPanel.hidden) { wsPanel.hidden = true; }
    if (!featureOn(f, 'recording', 'screen') && !srPanel.hidden && !screenRec.active) srPanel.hidden = true;
    if (!featureOn(f, 'intelligence', 'frequency')) { state.tools.freq = false; if (drawer === 'freq') closeDrawer(); }
    if (!featureOn(f, 'observation', 'log') && drawer === 'history') closeDrawer();
    save(); updateDock();
  }

  // ------------------------------------------------------------------ misc
  function toast(msg) { ctx.status(msg, { retry: false }); setTimeout(() => ctx.status(null), 2600); }
  function fmt(s) { s = Math.floor(s); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }
  devices.addEventListener('change', () => { if ($('settingsDlg').open) renderDeviceCards(); if (!wsPanel.hidden) refreshWsDevices(); });
  if (on('device', 'discovery')) devices.start();
  if (state.obsMode === 'private') obs.load().catch(() => {});
  window.addEventListener('pagehide', () => { ws.clear(); screenRec.releaseSource(); });

  return {
    frame, applyFeatures, renderFeatureList, renderDeviceCards, updateDock,
    onStream(stream) { const t = stream?.getVideoTracks()[0]; if (t && on('device', 'discovery')) devices.noteTrack(t); devices.refresh(); },
    busy: () => screenRec.active || ws.recording,
  };
}
