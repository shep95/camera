// Adaptive focus: rounded magnification windows that follow tracked targets. The primary camera
// image is never modified; each window is a separate crop of the same live frame.
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class AdaptiveFocus {
  constructor(opts = {}) {
    this.windows = []; this.nextId = 1;
    this.opts = { zoom: 4, follow: true, stabilize: true, auto: true, maxAuto: 2, threshold: 0.45, holdLostMs: 2500, closeAfterMs: 6000, ...opts };
  }
  set(opts) { Object.assign(this.opts, opts); }

  /** Update windows from the tracker's tracks. Returns events for the observation log. */
  update(tracks, now) {
    const o = this.opts, events = [];
    const byId = new Map(tracks.map((t) => [t.id, t]));
    for (const w of this.windows) {
      const t = w.trackId != null ? byId.get(w.trackId) : null;
      if (t && t.misses === 0) {
        if (w.state === 'lost' || w.state === 'reacquiring') events.push({ kind: 'reacquired', window: w });
        w.state = 'tracking'; w.lastSeen = now; this.moveTo(w, t.x, t.y, o.follow);
        w.targetW = t.w; w.targetH = t.h;
      } else if (t && t.state === 'predicting') {
        w.state = 'predicting'; if (o.follow) this.moveTo(w, t.px, t.py, true);
      } else if (t) {
        if (w.state !== 'lost') { w.state = 'lost'; w.lostAt = now; events.push({ kind: 'lost', window: w }); }
      } else if (w.trackId != null) {
        if (w.state !== 'lost' && w.state !== 'released') { w.state = 'lost'; w.lostAt = now; events.push({ kind: 'lost', window: w }); }
        // try to reacquire: a new track near the last position
        const near = tracks.find((x) => x.hits >= 3 && Math.hypot(x.x - w.cx, x.y - w.cy) < 0.08);
        if (near) { w.trackId = near.id; w.state = 'reacquiring'; }
        else if (!w.pinned && now - w.lostAt > o.closeAfterMs) { w.state = 'released'; events.push({ kind: 'released', window: w }); }
      }
    }
    this.windows = this.windows.filter((w) => w.state !== 'released' || w.pinned);
    // auto-open for significant tracks
    if (o.auto) {
      const open = new Set(this.windows.map((w) => w.trackId));
      const autoCount = this.windows.filter((w) => !w.manual).length;
      const cands = tracks.filter((t) => t.hits >= 6 && t.misses === 0 && t.score >= o.threshold && !open.has(t.id)).sort((a, b) => b.score - a.score);
      for (const t of cands) {
        if (this.windows.filter((w) => !w.manual).length >= o.maxAuto) break;
        const w = this.open({ trackId: t.id, cx: t.x, cy: t.y, manual: false }); w.targetW = t.w; w.targetH = t.h;
        events.push({ kind: 'acquired', window: w, track: t });
      }
      void autoCount;
    }
    return events;
  }

  moveTo(w, x, y, smooth) {
    const a = smooth && this.opts.stabilize ? 0.3 : 1;
    w.cx += (x - w.cx) * a; w.cy += (y - w.cy) * a;
  }

  open({ trackId = null, cx, cy, manual = true }) {
    const w = { id: this.nextId++, trackId, cx, cy, manual, pinned: false, state: trackId != null ? 'tracking' : 'static', lastSeen: performance.now(), lostAt: 0, zoom: this.opts.zoom, targetW: 0, targetH: 0 };
    this.windows.push(w); return w;
  }
  close(id) { this.windows = this.windows.filter((w) => w.id !== id); }
  closeAll() { this.windows = []; }

  /** Source crop rectangle in source pixels for a window (square crop, clamped to the frame). */
  cropRect(w, W, H) {
    const z = clamp(w.zoom || this.opts.zoom, 1.5, 16);
    const size = Math.max(16, Math.round(Math.min(W, H) / z));
    const sx = clamp(Math.round(w.cx * W - size / 2), 0, Math.max(0, W - size));
    const sy = clamp(Math.round(w.cy * H - size / 2), 0, Math.max(0, H - size));
    return { sx, sy, size };
  }
}
