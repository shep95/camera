// Optical intelligence (non-AI). Deterministic computer vision on the ORIGINAL camera frames:
// frame differencing with a running background model, camera-motion compensation (global shift
// search), connected components, constant-velocity tracking with prediction, attention scoring,
// small transient feature ("particle candidate") detection and optical flicker analysis.
// Nothing here is a learned model. A detection is an observation of change, not a classification.

const AW = 128, AH = 72;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class MotionAnalyzer {
  constructor() {
    this.canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(AW, AH) : Object.assign(document.createElement('canvas'), { width: AW, height: AH });
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.prev = null; this.bg = null; this.noise = 0.02; this.frames = 0;
    this.lastShift = { dx: 0, dy: 0 };
  }

  /** @returns {{blobs:Array, particles:Array, motion:number, shift:{dx:number,dy:number}, luma:number}} */
  analyze(source) {
    this.ctx.drawImage(source, 0, 0, AW, AH);
    const { data } = this.ctx.getImageData(0, 0, AW, AH);
    const L = new Float32Array(AW * AH);
    let sum = 0;
    for (let i = 0, p = 0; i < L.length; i++, p += 4) { const y = (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) / 255; L[i] = y; sum += y; }
    const luma = sum / L.length;
    this.frames++;
    if (!this.prev) { this.prev = L; this.bg = Float32Array.from(L); return { blobs: [], particles: [], motion: 0, shift: { dx: 0, dy: 0 }, luma, L, W: AW, H: AH }; }

    // --- camera-motion compensation: global integer shift that best aligns previous and current frame
    const shift = estimateShift(this.prev, L, AW, AH, 3);
    this.lastShift = shift;
    if (shift.dx || shift.dy) { this.bg = shiftImage(this.bg, AW, AH, shift.dx, shift.dy); }

    // --- foreground: |current - background| above an adaptive threshold (noise-aware)
    const diff = new Float32Array(L.length);
    let nsum = 0, ncount = 0, motionPix = 0;
    for (let i = 0; i < L.length; i++) { const d = Math.abs(L[i] - this.bg[i]); diff[i] = d; if (d < 0.05) { nsum += d; ncount++; } }
    this.noise = this.noise * 0.9 + (ncount ? nsum / ncount : 0) * 0.1;
    const thr = clamp(0.06 + this.noise * 4, 0.06, 0.25);
    const mask = new Uint8Array(L.length);
    for (let i = 0; i < L.length; i++) { if (diff[i] > thr) { mask[i] = 1; motionPix++; } }
    // background adapts slowly, faster where there is no motion (so moving things do not burn in)
    for (let i = 0; i < L.length; i++) { const a = mask[i] ? 0.01 : 0.06; this.bg[i] += (L[i] - this.bg[i]) * a; }

    // --- connected components over the motion mask
    const blobs = components(mask, AW, AH, 4).map((b) => ({
      x: (b.minX + b.maxX + 1) / 2 / AW, y: (b.minY + b.maxY + 1) / 2 / AH,
      w: (b.maxX - b.minX + 1) / AW, h: (b.maxY - b.minY + 1) / AH,
      area: b.n / (AW * AH), contrast: b.sum / b.n, px: b.n,
    })).filter((b) => b.area < 0.6).sort((a, b) => b.area - a.area).slice(0, 12);

    // --- particle candidates: tiny bright transient features (high-pass + temporal change, area ≤ 3 px)
    const particles = [];
    for (let y = 1; y < AH - 1; y++) for (let x = 1; x < AW - 1; x++) {
      const i = y * AW + x;
      const local = (L[i - 1] + L[i + 1] + L[i - AW] + L[i + AW] + L[i - AW - 1] + L[i - AW + 1] + L[i + AW - 1] + L[i + AW + 1]) / 8;
      const hp = L[i] - local;
      if (hp > 0.10 && Math.abs(L[i] - this.prev[i]) > 0.04 && L[i] > local + 0.1) {
        if (particles.length < 200) particles.push({ x: (x + 0.5) / AW, y: (y + 0.5) / AH, b: hp });
      }
    }
    this.prev = L;
    return { blobs, particles, motion: motionPix / L.length, shift: { dx: shift.dx / AW, dy: shift.dy / AH }, luma, threshold: thr, noise: this.noise, L, W: AW, H: AH };
  }
}

/** Integer global shift (dx, dy) minimising the sum of absolute differences on a sub-sampled grid. */
export function estimateShift(a, b, W, H, R) {
  let best = { dx: 0, dy: 0, sad: Infinity };
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    let sad = 0, n = 0;
    for (let y = R; y < H - R; y += 2) for (let x = R; x < W - R; x += 2) { sad += Math.abs(a[(y - dy) * W + (x - dx)] - b[y * W + x]); n++; }
    sad /= n;
    // prefer zero shift unless a shift is clearly better (avoid jitter on noise)
    if (sad < best.sad - (dx || dy ? 0.002 : 0)) best = { dx, dy, sad };
  }
  return best;
}

export function shiftImage(img, W, H, dx, dy) {
  const out = new Float32Array(img.length);
  for (let y = 0; y < H; y++) { const sy = clamp(y - dy, 0, H - 1); for (let x = 0; x < W; x++) out[y * W + x] = img[sy * W + clamp(x - dx, 0, W - 1)]; }
  return out;
}

/** 4-connected components of a binary mask; returns bbox, pixel count and summed contrast weight. */
export function components(mask, W, H, minPx = 4, weight = null) {
  const seen = new Uint8Array(mask.length); const out = []; const stack = new Int32Array(mask.length);
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || seen[s]) continue;
    let sp = 0; stack[sp++] = s; seen[s] = 1;
    const c = { minX: W, maxX: 0, minY: H, maxY: 0, n: 0, sum: 0 };
    while (sp) {
      const i = stack[--sp]; const x = i % W, y = (i / W) | 0;
      c.n++; c.sum += weight ? weight[i] : 1;
      if (x < c.minX) c.minX = x; if (x > c.maxX) c.maxX = x; if (y < c.minY) c.minY = y; if (y > c.maxY) c.maxY = y;
      const nb = [i - 1, i + 1, i - W, i + W];
      if (x === 0) nb[0] = -1; if (x === W - 1) nb[1] = -1;
      for (const j of nb) if (j >= 0 && j < mask.length && mask[j] && !seen[j]) { seen[j] = 1; stack[sp++] = j; }
    }
    if (c.n >= minPx) out.push(c);
  }
  return out;
}

/**
 * Multi-target tracker with constant-velocity prediction (a Kalman-style predict/update without
 * the full covariance machinery). States: acquired → tracking → lost (predicting) → released.
 */
export class Tracker {
  constructor(opts = {}) {
    this.tracks = []; this.nextId = 1;
    this.opts = { gate: 0.08, maxMisses: 12, releaseAfter: 30, minArea: 0.0004, ...opts };
  }
  update(blobs, dt, shift = { dx: 0, dy: 0 }) {
    const o = this.opts; dt = clamp(dt || 1 / 30, 1 / 120, 0.5);
    // predict (and compensate camera motion: the scene moved by `shift`, so targets did too)
    for (const t of this.tracks) { t.px = t.x + t.vx * dt + shift.dx; t.py = t.y + t.vy * dt + shift.dy; }
    const used = new Set();
    for (const t of this.tracks) {
      let best = null, bd = o.gate + Math.hypot(t.vx, t.vy) * dt * 2;
      blobs.forEach((b, i) => { if (used.has(i)) return; const d = Math.hypot(b.x - t.px, b.y - t.py); if (d < bd) { bd = d; best = i; } });
      if (best != null) {
        const b = blobs[best]; used.add(best);
        const nvx = (b.x - t.x) / dt, nvy = (b.y - t.y) / dt;
        t.vx += (nvx - t.vx) * 0.35; t.vy += (nvy - t.vy) * 0.35;
        t.jitter = t.jitter * 0.8 + Math.hypot(nvx - t.vx, nvy - t.vy) * 0.2;
        t.x = b.x; t.y = b.y; t.w += (b.w - t.w) * 0.5; t.h += (b.h - t.h) * 0.5; t.area = b.area; t.contrast = t.contrast * 0.7 + b.contrast * 0.3;
        t.hits++; t.misses = 0; t.state = t.hits < 3 ? 'acquired' : 'tracking'; t.lastSeen = performance.now();
      } else {
        t.misses++; t.x = t.px; t.y = t.py; t.vx *= 0.9; t.vy *= 0.9;
        t.state = t.misses > o.maxMisses ? 'lost' : t.state === 'acquired' ? 'acquired' : 'predicting';
      }
      t.age++;
      t.history.push({ x: t.x, y: t.y, t: performance.now() }); if (t.history.length > 90) t.history.shift();
      t.score = attentionScore(t);
    }
    // new tracks from unmatched blobs
    blobs.forEach((b, i) => {
      if (used.has(i) || b.area < o.minArea) return;
      this.tracks.push({ id: this.nextId++, x: b.x, y: b.y, w: b.w, h: b.h, vx: 0, vy: 0, px: b.x, py: b.y, area: b.area, contrast: b.contrast, jitter: 0, hits: 1, misses: 0, age: 1, state: 'acquired', history: [{ x: b.x, y: b.y, t: performance.now() }], score: 0, lastSeen: performance.now() });
    });
    const released = this.tracks.filter((t) => t.misses > o.releaseAfter);
    this.tracks = this.tracks.filter((t) => t.misses <= o.releaseAfter);
    return { tracks: this.tracks, released };
  }
}

/** Deterministic attention score S = wm·M + wc·C + wp·P + wt·T − wn·N (all terms 0..1). */
export function attentionScore(t, w = { m: 0.3, c: 0.25, p: 0.3, t: 0.15, n: 0.4 }) {
  const M = clamp(Math.hypot(t.vx, t.vy) / 0.6, 0, 1);              // motion significance
  const C = clamp(t.contrast / 0.3, 0, 1);                           // contrast / distinctiveness
  const P = clamp(t.hits / 30, 0, 1);                                // persistence
  const aspect = t.w && t.h ? (t.w * 16 / 9) / t.h : 1;              // template: plate-like rectangle (aspect 2–5)
  const T = aspect >= 2 && aspect <= 5 && t.area > 0.001 ? 1 : 0;
  const N = clamp(t.jitter / 0.8, 0, 1);                             // instability
  return clamp(w.m * M + w.c * C + w.p * P + w.t * T - w.n * N, 0, 1);
}

/**
 * Optical frequency analysis: a ring buffer of brightness samples and a DFT over it.
 * Limited by the frame rate (Nyquist = fps / 2), exposure and aliasing. Measured, not inferred.
 */
export class FlickerAnalyzer {
  constructor(n = 128) { this.n = n; this.v = []; this.t = []; }
  push(value, time) { this.v.push(value); this.t.push(time); if (this.v.length > this.n) { this.v.shift(); this.t.shift(); } }
  spectrum() {
    const n = this.v.length; if (n < 16) return null;
    const dur = (this.t[n - 1] - this.t[0]) / 1000; const fps = (n - 1) / Math.max(dur, 1e-3);
    const mean = this.v.reduce((a, b) => a + b, 0) / n;
    const bins = []; const half = n >> 1;
    for (let k = 1; k < half; k++) {
      let re = 0, im = 0;
      for (let i = 0; i < n; i++) { const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)); const x = (this.v[i] - mean) * w; const a = (2 * Math.PI * k * i) / n; re += x * Math.cos(a); im -= x * Math.sin(a); }
      bins.push({ hz: (k * fps) / n, mag: Math.hypot(re, im) / n });
    }
    let peak = bins[0]; for (const b of bins) if (b.mag > peak.mag) peak = b;
    return { bins, peak, fps, nyquist: fps / 2, samples: n };
  }
}

/**
 * Spatial flicker field: a coarse grid of brightness histories so the frequency seer can show
 * WHERE in the image a brightness oscillation occurs, and at what rate. Each cell gets a DFT over
 * the last N samples. Measured, limited to half the sampling rate; mains flicker aliases.
 */
export class FlickerField {
  constructor(cols = 16, rows = 9, n = 64) {
    this.cols = cols; this.rows = rows; this.n = n; this.cells = cols * rows;
    this.buf = new Float32Array(this.cells * n); this.head = 0; this.count = 0; this.times = new Float64Array(n);
    this.result = null;
  }
  /** Push one analysis frame (luma array W×H) at time t (ms). */
  push(L, W, H, t) {
    const cw = W / this.cols, ch = H / this.rows; const idx = this.head;
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
      let s = 0, n = 0; const x0 = Math.floor(c * cw), x1 = Math.floor((c + 1) * cw), y0 = Math.floor(r * ch), y1 = Math.floor((r + 1) * ch);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += L[y * W + x]; n++; }
      this.buf[(r * this.cols + c) * this.n + idx] = n ? s / n : 0;
    }
    this.times[idx] = t; this.head = (idx + 1) % this.n; if (this.count < this.n) this.count++;
  }
  /** Compute dominant oscillation per cell. Returns { cells:[{c,r,hz,mag,phase}], fps, nyquist, dominant }. */
  compute() {
    const n = this.count; if (n < 24) return null;
    const order = []; for (let i = 0; i < n; i++) order.push((this.head - n + i + this.n) % this.n);
    const dur = (this.times[order[n - 1]] - this.times[order[0]]) / 1000; const fps = (n - 1) / Math.max(dur, 1e-3);
    const half = n >> 1; const cos = [], sin = [];
    for (let k = 1; k < half; k++) { const ck = new Float32Array(n), sk = new Float32Array(n); for (let i = 0; i < n; i++) { const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)); const a = (2 * Math.PI * k * i) / n; ck[i] = Math.cos(a) * w; sk[i] = Math.sin(a) * w; } cos.push(ck); sin.push(sk); }
    const cells = []; let dominant = null;
    for (let cell = 0; cell < this.cells; cell++) {
      const base = cell * this.n; let mean = 0; for (let i = 0; i < n; i++) mean += this.buf[base + order[i]]; mean /= n;
      let bestK = 0, bestM = 0, bestPh = 0, total = 0;
      for (let k = 1; k < half; k++) {
        let re = 0, im = 0; const ck = cos[k - 1], sk = sin[k - 1];
        for (let i = 0; i < n; i++) { const x = this.buf[base + order[i]] - mean; re += x * ck[i]; im -= x * sk[i]; }
        const m = Math.hypot(re, im) / n; total += m; if (m > bestM) { bestM = m; bestK = k; bestPh = Math.atan2(im, re); }
      }
      const snr = total > 0 ? bestM / (total / (half - 1)) : 0; // how much the peak stands out from the rest
      const e = { c: cell % this.cols, r: (cell / this.cols) | 0, hz: (bestK * fps) / n, mag: bestM, phase: bestPh, snr };
      cells.push(e); if (bestM > 0.003 && snr > 2.5 && (!dominant || bestM > dominant.mag)) dominant = e;
    }
    this.result = { cells, fps, nyquist: fps / 2, samples: n, dominant };
    return this.result;
  }
}
