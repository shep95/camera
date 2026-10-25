import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateShift, shiftImage, components, Tracker, attentionScore, FlickerAnalyzer } from '../src/engine/vision.js';
import { AdaptiveFocus } from '../src/engine/focus.js';
import { FEATURES, DOMAINS, defaultFeatures, sanitizeFeatures, featureOn } from '../src/features.js';
import { guessModality, summarizeCaps } from '../src/engine/devices.js';

globalThis.performance ??= { now: () => Date.now() };

test('global shift estimation recovers a known camera motion', () => {
  const W = 64, H = 36; const a = new Float32Array(W * H);
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < a.length; i++) a[i] = rnd();
  const b = shiftImage(a, W, H, 2, -1);
  const s = estimateShift(a, b, W, H, 3);
  assert.equal(s.dx, 2); assert.equal(s.dy, -1);
});

test('connected components find separate moving regions', () => {
  const W = 16, H = 8; const m = new Uint8Array(W * H);
  for (let y = 1; y < 4; y++) for (let x = 1; x < 4; x++) m[y * W + x] = 1;
  for (let y = 4; y < 7; y++) for (let x = 10; x < 15; x++) m[y * W + x] = 1;
  m[0] = 1; // a lone pixel below minPx
  const c = components(m, W, H, 4);
  assert.equal(c.length, 2); assert.equal(c[0].n, 9); assert.equal(c[1].n, 15); assert.equal(c[1].minX, 10);
});

test('tracker follows a moving blob, predicts through a gap, and releases', () => {
  const tr = new Tracker({ maxMisses: 3, releaseAfter: 6 });
  let tracks;
  for (let i = 0; i < 10; i++) ({ tracks } = tr.update([{ x: 0.1 + i * 0.02, y: 0.5, w: 0.05, h: 0.05, area: 0.002, contrast: 0.3 }], 1 / 30));
  assert.equal(tracks.length, 1); const t = tracks[0];
  assert.equal(t.state, 'tracking'); assert.ok(t.vx > 0.3, `velocity ${t.vx}`); assert.ok(t.score > 0.2);
  const xBefore = t.x;
  ({ tracks } = tr.update([], 1 / 30)); assert.equal(tracks[0].state, 'predicting'); assert.ok(tracks[0].x > xBefore, 'predicted forward');
  for (let i = 0; i < 4; i++) ({ tracks } = tr.update([], 1 / 30)); assert.equal(tracks[0].state, 'lost');
  const res = tr.update([], 1 / 30); for (let i = 0; i < 3; i++) tr.update([], 1 / 30);
  assert.equal(tr.tracks.length, 0, 'released'); void res;
});

test('attention score rewards persistence and penalises jitter', () => {
  const base = { vx: 0.3, vy: 0, contrast: 0.2, hits: 30, w: 0.05, h: 0.05, area: 0.002, jitter: 0 };
  const calm = attentionScore(base), noisy = attentionScore({ ...base, jitter: 0.8 }), young = attentionScore({ ...base, hits: 2 });
  assert.ok(calm > noisy && calm > young);
  assert.ok(attentionScore({ ...base, w: 0.09, h: 0.04 }) > calm, 'plate-like aspect gets the template term');
});

test('flicker analyser finds a 5 Hz oscillation at 30 fps', () => {
  const f = new FlickerAnalyzer(128);
  for (let i = 0; i < 128; i++) f.push(0.5 + 0.1 * Math.sin(2 * Math.PI * 5 * (i / 30)), i * (1000 / 30));
  const sp = f.spectrum();
  assert.ok(Math.abs(sp.peak.hz - 5) < 0.4, `peak ${sp.peak.hz}`); assert.ok(Math.abs(sp.nyquist - 15) < 0.2);
});

test('adaptive focus opens, follows, marks lost and releases', () => {
  const f = new AdaptiveFocus({ threshold: 0.3, closeAfterMs: 100 });
  const track = { id: 7, x: 0.3, y: 0.4, w: 0.05, h: 0.05, hits: 10, misses: 0, score: 0.8, state: 'tracking', px: 0.3, py: 0.4 };
  let ev = f.update([track], 0); assert.equal(ev[0]?.kind, 'acquired'); assert.equal(f.windows.length, 1);
  track.x = 0.5; f.update([track], 10); assert.ok(f.windows[0].cx > 0.3 && f.windows[0].cx <= 0.5);
  ev = f.update([], 20); assert.equal(ev[0]?.kind, 'lost'); assert.equal(f.windows[0].state, 'lost');
  ev = f.update([], 200); assert.equal(ev[0]?.kind, 'released'); assert.equal(f.windows.length, 0);
  const r = f.cropRect({ cx: 0.99, cy: 0.5, zoom: 4 }, 1920, 1080); assert.equal(r.size, 270); assert.equal(r.sx + r.size, 1920, 'clamped to frame');
  assert.equal(f.update([{ ...track, id: 8 }, { ...track, id: 9 }, { ...track, id: 10 }], 300).length, 2, 'max two auto windows');
});

test('feature registry: 7 domains, switches sanitised, locks respected', () => {
  assert.equal(DOMAINS.length, 7); assert.deepEqual(Object.keys(FEATURES), DOMAINS.map((d) => d.id));
  for (const d of Object.values(FEATURES)) for (const v of Object.values(d)) { assert.equal(typeof v[0], 'boolean'); assert.ok(v[1] && v[2]); }
  const f = sanitizeFeatures({ intelligence: { enabled: false, motion: 'yes' }, privacy: { faceId: true, localOnly: false }, bogus: { x: true } });
  assert.equal(f.intelligence.enabled, false); assert.equal(f.intelligence.motion, true); assert.equal(f.privacy.faceId, false); assert.equal(f.privacy.localOnly, true); assert.equal(f.bogus, undefined);
  assert.equal(featureOn(f, 'intelligence', 'motion'), false, 'domain master off disables feature');
  assert.equal(featureOn(defaultFeatures(), 'intelligence', 'motion'), true);
});

test('device modality is guessed from the name and marked unverified', () => {
  assert.equal(guessModality('FLIR Lepton').verified, false); assert.match(guessModality('FLIR Lepton').guess, /thermal/);
  assert.equal(guessModality('FaceTime HD Camera').guess, 'visible_light'); assert.match(guessModality('OBS Virtual Camera').guess, /virtual/);
  const c = summarizeCaps({ width: { min: 1, max: 1920 }, frameRate: { min: 1, max: 30 }, zoom: {}, deviceId: 'x' });
  assert.equal(c.width, '1–1920'); assert.deepEqual(c.controls, ['zoom']);
});

test('flicker field localises a 4 Hz oscillation to one cell', async () => {
  const { FlickerField } = await import('../src/engine/vision.js');
  const W = 32, H = 18, f = new FlickerField(16, 9, 64);
  for (let i = 0; i < 64; i++) {
    const L = new Float32Array(W * H).fill(0.5); const v = 0.5 + 0.2 * Math.sin(2 * Math.PI * 4 * (i / 30));
    for (let y = 2; y < 4; y++) for (let x = 20; x < 22; x++) L[y * W + x] = v; // cells (10,1)
    f.push(L, W, H, i * (1000 / 30));
  }
  const r = f.compute();
  assert.ok(r.dominant, 'a dominant cell'); assert.equal(r.dominant.c, 10); assert.equal(r.dominant.r, 1);
  assert.ok(Math.abs(r.dominant.hz - 4) < 0.5, `hz ${r.dominant.hz}`); assert.ok(r.dominant.snr > 2.5);
});

test('performance controller steps down under load and back up when cool, never while locked', async () => {
  const { PerfController } = await import('../src/engine/perf.js');
  const p = new PerfController({ start: 'full', hold: 1000 });
  for (let i = 0; i < 60; i++) p.tick(40, 2000 + i * 10); assert.equal(p.tier, 'balanced', 'one step down per hold period');
  for (let i = 0; i < 60; i++) p.tick(40, 4000 + i * 10); assert.equal(p.tier, 'eco');
  p.locked = true; for (let i = 0; i < 60; i++) p.tick(8, 6000 + i * 10); assert.equal(p.tier, 'eco', 'locked while recording');
  p.locked = false; for (let i = 0; i < 60; i++) p.tick(8, 8000 + i * 10); assert.equal(p.tier, 'balanced');
  assert.deepEqual(p.renderSize(3840, 2160), [1920, 1080]); assert.deepEqual(p.renderSize(1280, 720), [1280, 720]);
  p.set('full'); for (let i = 0; i < 60; i++) p.tick(50, 400 + i); assert.equal(p.tier, 'full', 'manual tier is not overridden');
});

test('camera-paced load metric: work time and skipped frames drive the tier, not the camera interval', async () => {
  const { PerfController } = await import('../src/engine/perf.js');
  const p = new PerfController({ start: 'balanced', hold: 1000 });
  for (let i = 0; i < 80; i++) p.tickLoad(3, 0, 2000 + i * 33); assert.equal(p.tier, 'full', 'light work at 30 fps steps up');
  for (let i = 0; i < 25; i++) p.tickLoad(4, 1, 5000 + i * 33); assert.equal(p.tier, 'balanced', 'skipped frames step down');
  for (let i = 0; i < 80; i++) p.tickLoad(20, 0, 8000 + i * 33); assert.equal(p.tier, 'eco', 'heavy main-thread work steps down');
});
