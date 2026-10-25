// Adaptive quality controller: keeps the live loop fast and cool.
// It watches the frame time and moves between tiers that trade preview resolution and analysis
// cadence for headroom. Photo capture always renders at native resolution; a tier never changes
// while a recording is in progress so the recorded canvas keeps one size.
export const TIERS = {
  full:     { label: 'Full',     maxWidth: 3840, analysisStride: 3, thumbMs: 500 },
  balanced: { label: 'Balanced', maxWidth: 1920, analysisStride: 4, thumbMs: 700 },
  eco:      { label: 'Eco',      maxWidth: 1280, analysisStride: 6, thumbMs: 1000 },
};
const ORDER = ['full', 'balanced', 'eco'];

export class PerfController {
  constructor(opts = {}) {
    this.tier = opts.start || 'balanced'; this.ema = 16; this.lastSwitch = 0; this.locked = false; this.auto = true;
    this.lowerAt = opts.lowerAt ?? 26; this.raiseAt = opts.raiseAt ?? 13; this.hold = opts.hold ?? 4000;
  }
  get cfg() { return TIERS[this.tier]; }
  /** Feed one frame's wall time (ms between frames). Returns true when the tier changed. */
  tick(dtMs, now) {
    if (!Number.isFinite(dtMs) || dtMs <= 0) return false;
    this.ema = this.ema * 0.9 + Math.min(dtMs, 200) * 0.1;
    if (!this.auto || this.locked || now - this.lastSwitch < this.hold) return false;
    const i = ORDER.indexOf(this.tier);
    if (this.ema > this.lowerAt && i < ORDER.length - 1) { this.tier = ORDER[i + 1]; this.lastSwitch = now; return true; }
    if (this.ema < this.raiseAt && i > 0) { this.tier = ORDER[i - 1]; this.lastSwitch = now; return true; }
    return false;
  }
  /**
   * Camera-paced variant: the interval between callbacks is the camera's frame period, not a load
   * signal. Load = main-thread work per frame plus frames the browser had to skip because the GPU or
   * main thread fell behind. Steps down when either is sustained, up when both are comfortably low.
   */
  tickLoad(workMs, skipped, now) {
    if (!Number.isFinite(workMs) || workMs < 0) return false;
    this.ema = this.ema * 0.9 + Math.min(workMs, 200) * 0.1;
    this.skipEma = (this.skipEma ?? 0) * 0.9 + Math.min(skipped || 0, 5) * 0.1;
    if (!this.auto || this.locked || now - this.lastSwitch < this.hold) return false;
    const i = ORDER.indexOf(this.tier);
    if ((this.ema > 12 || this.skipEma > 0.35) && i < ORDER.length - 1) { this.tier = ORDER[i + 1]; this.lastSwitch = now; return true; }
    if (this.ema < 5 && this.skipEma < 0.05 && i > 0) { this.tier = ORDER[i - 1]; this.lastSwitch = now; return true; }
    return false;
  }
  set(tier) { if (TIERS[tier]) { this.tier = tier; this.auto = false; } }
  setAuto() { this.auto = true; }
  /** Preview render size for a source of W×H under the current tier. */
  renderSize(W, H) { const cap = this.cfg.maxWidth; if (W <= cap) return [W, H]; const s = cap / W; return [cap, Math.round(H * s)]; }
}
