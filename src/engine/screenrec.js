// Desktop recording as a first-class source: screen/window/tab via getDisplayMedia, with a
// non-destructive camera overlay layer (position, size, shape, opacity are layer properties),
// mixed microphone + system audio, pause/resume, and WebM export.
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class ScreenRecorder extends EventTarget {
  constructor() {
    super();
    this.screen = null; this.video = document.createElement('video'); this.video.muted = true; this.video.playsInline = true;
    this.canvas = document.createElement('canvas'); this.ctx = this.canvas.getContext('2d');
    this.overlay = { enabled: true, shape: 'rounded', size: 'medium', x: 0.97, y: 0.97, opacity: 1, border: true };
    this.rec = null; this.chunks = []; this.audioCtx = null; this.raf = 0; this.state = 'idle'; this.startedAt = 0; this.pausedTotal = 0; this.pausedAt = 0;
    this.sourceCanvas = null; this.mime = '';
  }
  get active() { return this.state === 'recording' || this.state === 'paused'; }
  get elapsed() { if (!this.startedAt) return 0; const end = this.state === 'paused' ? this.pausedAt : performance.now(); return (end - this.startedAt - this.pausedTotal) / 1000; }

  /** Ask the user for a screen/window/tab. Must be called from a user gesture. */
  async selectSource({ systemAudio = true } = {}) {
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('Screen capture is not supported in this browser.');
    this.releaseSource();
    this.screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: systemAudio });
    this.video.srcObject = this.screen; await this.video.play().catch(() => {});
    await new Promise((r) => (this.video.readyState >= 2 ? r() : this.video.addEventListener('loadeddata', r, { once: true })));
    const s = this.screen.getVideoTracks()[0].getSettings();
    this.canvas.width = s.width || this.video.videoWidth || 1920; this.canvas.height = s.height || this.video.videoHeight || 1080;
    this.screen.getVideoTracks()[0].addEventListener('ended', () => { this.dispatchEvent(new Event('sourceended')); if (this.active) this.stop(); else this.releaseSource(); });
    this.dispatchEvent(new Event('source'));
    if (!this.raf) this.loop();
    return { width: this.canvas.width, height: this.canvas.height, label: this.screen.getVideoTracks()[0].label || 'screen', hasAudio: this.screen.getAudioTracks().length > 0 };
  }
  releaseSource() { this.screen?.getTracks().forEach((t) => t.stop()); this.screen = null; cancelAnimationFrame(this.raf); this.raf = 0; }

  loop() { this.raf = requestAnimationFrame(() => this.loop()); this.compose(); }

  /** Draw the screen frame, then the camera overlay as a composited layer. */
  compose() {
    if (!this.screen || this.video.readyState < 2) return;
    const c = this.canvas, x = this.ctx; x.drawImage(this.video, 0, 0, c.width, c.height);
    const o = this.overlay, src = this.sourceCanvas;
    if (!o.enabled || !src || !src.width) return;
    const frac = o.size === 'small' ? 0.16 : o.size === 'large' ? 0.34 : 0.24;
    const w = Math.round(c.width * frac), h = o.shape === 'circle' || o.shape === 'square' ? w : Math.round(w * (src.height / src.width));
    const px = Math.round(o.x * (c.width - w)), py = Math.round(o.y * (c.height - h));
    const r = o.shape === 'circle' ? w / 2 : o.shape === 'rounded' ? Math.round(w * 0.12) : 0;
    x.save(); x.globalAlpha = clamp(o.opacity, 0.1, 1);
    x.beginPath(); roundRect(x, px, py, w, h, r); x.closePath(); x.clip();
    // cover-fit the camera into the overlay box
    const sAspect = src.width / src.height, dAspect = w / h; let sw = src.width, sh = src.height, sx = 0, sy = 0;
    if (sAspect > dAspect) { sw = src.height * dAspect; sx = (src.width - sw) / 2; } else { sh = src.width / dAspect; sy = (src.height - sh) / 2; }
    x.drawImage(src, sx, sy, sw, sh, px, py, w, h); x.restore();
    if (o.border) { x.save(); x.strokeStyle = 'rgba(255,255,255,0.85)'; x.lineWidth = Math.max(2, c.width / 640); x.beginPath(); roundRect(x, px, py, w, h, r); x.stroke(); x.restore(); }
    this.lastBox = { x: px / c.width, y: py / c.height, w: w / c.width, h: h / c.height };
  }

  async start({ mic = true, sourceCanvas = null, fps = 30 } = {}) {
    if (!this.screen) throw new Error('Select a screen first.');
    if (typeof MediaRecorder === 'undefined') throw new Error('Recording is not supported in this browser.');
    this.sourceCanvas = sourceCanvas;
    const out = this.canvas.captureStream(fps);
    // mix system audio + microphone through WebAudio into one track
    const sources = [];
    if (this.screen.getAudioTracks().length) sources.push(new MediaStream(this.screen.getAudioTracks()));
    if (mic) { try { this.mic = await navigator.mediaDevices.getUserMedia({ audio: true }); sources.push(this.mic); } catch { this.mic = null; } }
    if (sources.length) {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const dest = this.audioCtx.createMediaStreamDestination();
      for (const s of sources) this.audioCtx.createMediaStreamSource(s).connect(dest);
      dest.stream.getAudioTracks().forEach((t) => out.addTrack(t));
    }
    const mimes = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
    this.mime = mimes.find((m) => MediaRecorder.isTypeSupported(m)) || '';
    this.rec = new MediaRecorder(out, this.mime ? { mimeType: this.mime, videoBitsPerSecond: 10_000_000 } : undefined);
    this.chunks = []; this.rec.ondataavailable = (e) => { if (e.data?.size) this.chunks.push(e.data); };
    this.rec.start(500); this.state = 'recording'; this.startedAt = performance.now(); this.pausedTotal = 0; this.out = out;
    this.dispatchEvent(new Event('state'));
  }
  pause() { if (this.state !== 'recording') return; this.rec.pause(); this.state = 'paused'; this.pausedAt = performance.now(); this.dispatchEvent(new Event('state')); }
  resume() { if (this.state !== 'paused') return; this.rec.resume(); this.pausedTotal += performance.now() - this.pausedAt; this.state = 'recording'; this.dispatchEvent(new Event('state')); }
  stop() {
    return new Promise((resolve) => {
      if (!this.rec) return resolve(null);
      const rec = this.rec;
      rec.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.mime || 'video/webm' });
        this.out?.getTracks().forEach((t) => t.stop()); this.mic?.getTracks().forEach((t) => t.stop()); this.mic = null;
        this.audioCtx?.close().catch(() => {}); this.audioCtx = null; this.rec = null; this.state = 'idle'; this.startedAt = 0;
        this.dispatchEvent(new Event('state')); resolve(blob);
      };
      if (rec.state === 'paused') rec.resume();
      rec.stop();
    });
  }
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
}
