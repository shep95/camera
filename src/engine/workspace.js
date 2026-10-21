// Multi-camera workspace: every source (camera, screen, primary feed) is an independent tile in a
// synchronized grid. Recording can be independent (each original stream) or synchronized (the
// composed grid on one timeline). Timestamps come from one clock; frame-level sync is not claimed.
export class Workspace extends EventTarget {
  constructor() { super(); this.tiles = []; this.nextId = 1; this.layout = '2x2'; this.maximized = null; this.canvas = document.createElement('canvas'); this.ctx = this.canvas.getContext('2d'); this.recs = []; }

  async addCamera(deviceId, label) {
    if (this.tiles.length >= 4) throw new Error('The workspace holds up to four tiles.');
    const stream = await navigator.mediaDevices.getUserMedia({ video: deviceId ? { deviceId: { exact: deviceId }, width: { ideal: 1280 } } : { width: { ideal: 1280 } }, audio: false });
    return this.addStream(stream, 'camera', label || stream.getVideoTracks()[0].label || 'camera', deviceId);
  }
  async addScreen() {
    if (this.tiles.length >= 4) throw new Error('The workspace holds up to four tiles.');
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    return this.addStream(stream, 'screen', stream.getVideoTracks()[0].label || 'screen', null);
  }
  addStream(stream, kind, label, deviceId, owned = true) {
    const video = document.createElement('video'); video.muted = true; video.playsInline = true; video.autoplay = true; video.srcObject = stream; video.play().catch(() => {});
    const tile = { id: this.nextId++, kind, label: String(label).slice(0, 60), deviceId, stream, video, owned, record: true, t0: performance.now() };
    stream.getVideoTracks()[0]?.addEventListener('ended', () => this.remove(tile.id));
    this.tiles.push(tile); this.emit(); return tile;
  }
  remove(id) { const t = this.tiles.find((x) => x.id === id); if (!t) return; if (t.owned) t.stream.getTracks().forEach((tr) => tr.stop()); t.video.srcObject = null; this.tiles = this.tiles.filter((x) => x.id !== id); if (this.maximized === id) this.maximized = null; this.emit(); }
  move(id, toIndex) { const i = this.tiles.findIndex((t) => t.id === id); if (i < 0) return; const [t] = this.tiles.splice(i, 1); this.tiles.splice(Math.max(0, Math.min(toIndex, this.tiles.length)), 0, t); this.emit(); }
  clear() { for (const t of [...this.tiles]) this.remove(t.id); }
  emit() { this.dispatchEvent(new Event('change')); }

  /** Compose all tiles into one synchronized frame (for synchronized recording). */
  compose(W = 1920, H = 1080) {
    const c = this.canvas; if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const x = this.ctx; x.fillStyle = '#000'; x.fillRect(0, 0, W, H);
    const tiles = this.tiles.filter((t) => t.record); if (!tiles.length) return c;
    const cols = tiles.length === 1 ? 1 : 2, rows = Math.ceil(tiles.length / cols); const tw = W / cols, th = H / rows;
    tiles.forEach((t, i) => {
      if (t.video.readyState < 2) return;
      const vw = t.video.videoWidth, vh = t.video.videoHeight; const s = Math.min(tw / vw, th / vh); const dw = vw * s, dh = vh * s;
      const dx = (i % cols) * tw + (tw - dw) / 2, dy = Math.floor(i / cols) * th + (th - dh) / 2;
      x.drawImage(t.video, dx, dy, dw, dh);
      x.fillStyle = 'rgba(0,0,0,0.55)'; x.fillRect(dx, dy + dh - 28, dw, 28); x.fillStyle = '#fff'; x.font = '14px system-ui, sans-serif'; x.fillText(`${t.label} · ${t.kind} · t+${((performance.now() - t.t0) / 1000).toFixed(1)}s`, dx + 10, dy + dh - 9);
    });
    return c;
  }

  /** Start recording: 'sync' (composed grid) and/or 'independent' (each original stream). */
  startRecording({ mode = 'sync', fps = 30 } = {}) {
    if (typeof MediaRecorder === 'undefined') throw new Error('Recording is not supported.');
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
    const mk = (stream, name) => { const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); const chunks = []; r.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); }; r.start(500); return { r, chunks, name, mime }; };
    this.recs = [];
    if (mode === 'sync' || mode === 'both') { this.composeLoop = setInterval(() => this.compose(), 1000 / fps); this.recs.push(mk(this.canvas.captureStream(fps), 'workspace_sync')); }
    if (mode === 'independent' || mode === 'both') for (const t of this.tiles.filter((x) => x.record)) this.recs.push(mk(new MediaStream(t.stream.getVideoTracks()), `${t.kind}_${t.id}`));
    this.recordingSince = performance.now(); this.emit();
  }
  get recording() { return this.recs.length > 0; }
  stopRecording() {
    clearInterval(this.composeLoop);
    const done = this.recs.map(({ r, chunks, name, mime }) => new Promise((resolve) => { r.onstop = () => resolve({ name, blob: new Blob(chunks, { type: mime || 'video/webm' }) }); r.stop(); }));
    this.recs = []; this.emit();
    return Promise.all(done);
  }
}
