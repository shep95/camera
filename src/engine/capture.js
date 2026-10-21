// Capture: multi-frame photo burst with sharpness-based frame selection, video recording, saving.

const pad = (n) => String(n).padStart(2, '0');

/** Build a file name. The prefix (default "74") marks every True Vision capture. */
export function makeFilename(prefix, mode, ext, date = new Date()) {
  const safe = String(prefix || '74').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16) || '74';
  const d = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const t = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${safe}_truevision_${mode}_${d}_${t}.${ext}`;
}

/** Laplacian variance of a small grayscale copy: a classic focus / motion-blur measure. */
export function sharpnessOf(ctx, source, w, h) {
  ctx.drawImage(source, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const g = new Float32Array(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  let s = 0, s2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x; const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w]; s += l; s2 += l * l; n++;
  }
  return n ? s2 / n - (s / n) ** 2 : 0;
}

/**
 * Capture a burst of frames and keep the sharpest (expression timing, principle 113: several
 * frames across ~200 ms avoid a single frozen, blurred instant).
 * @param renderFrame  function that renders the next live frame into `canvas`
 */
export function captureBurst(canvas, renderFrame, frames = 6) {
  const out = document.createElement('canvas'); out.width = canvas.width; out.height = canvas.height;
  const octx = out.getContext('2d');
  const small = document.createElement('canvas'); small.width = 160; small.height = 90;
  const sctx = small.getContext('2d', { willReadFrequently: true });
  let best = -1, taken = 0;
  return new Promise((resolve) => {
    const step = () => {
      renderFrame();
      const s = sharpnessOf(sctx, canvas, small.width, small.height);
      if (s > best) { best = s; octx.drawImage(canvas, 0, 0); }
      if (++taken >= frames) resolve({ canvas: out, sharpness: best, frames: taken });
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/** Save a blob to the user's device (browser download). */
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return url;
}

export function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), type, quality));
}

/** Video recorder for the processed canvas, with optional microphone audio. */
export class Recorder {
  constructor() { this.rec = null; this.chunks = []; this.start = 0; this.mime = ''; }
  static pickMime() {
    const c = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
    return c.find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) || '';
  }
  get active() { return !!this.rec && this.rec.state === 'recording'; }
  get elapsed() { return this.active ? (performance.now() - this.start) / 1000 : 0; }
  begin(canvas, audioStream, fps = 30) {
    const stream = canvas.captureStream(fps);
    if (audioStream) audioStream.getAudioTracks().forEach((t) => stream.addTrack(t));
    this.mime = Recorder.pickMime();
    this.rec = new MediaRecorder(stream, this.mime ? { mimeType: this.mime, videoBitsPerSecond: 12_000_000 } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.start = performance.now();
    this.rec.start(250);
    this.stream = stream;
  }
  end() {
    return new Promise((resolve) => {
      if (!this.rec) return resolve(null);
      const rec = this.rec;
      rec.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.mime || 'video/webm' });
        this.stream?.getVideoTracks().forEach((t) => t.stop()); // audio tracks belong to the app's mic stream
        this.rec = null; resolve(blob);
      };
      rec.stop();
    });
  }
}
