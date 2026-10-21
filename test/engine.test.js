// Unit tests for the pure engine functions (run with: npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzePixels, estimateDistance } from '../src/engine/scene.js';
import { decide, distanceAdvice, neutralParams, MODES } from '../src/engine/decision.js';
import { auraGrade, autoDirection, learnStyle } from '../src/engine/aura.js';
import { makeFilename } from '../src/engine/capture.js';
import { PRINCIPLES, GROUPS, principle, groupOf } from '../src/engine/principles.js';

function frame(W, H, fill) {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const [r, g, b] = fill(x, y); const p = (y * W + x) * 4; d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = 255; }
  return d;
}

test('115 principles in seven models', () => {
  assert.equal(PRINCIPLES.length, 115);
  assert.equal(GROUPS.length, 7);
  assert.equal(principle(74), '74. brightness constancy');
  assert.equal(groupOf(112).id, 'portrait');
});

test('scene analysis finds a skin-coloured face and estimates distance', () => {
  const W = 96, H = 54;
  const data = frame(W, H, (x, y) => (Math.hypot(x - 48, y - 27) < 12 ? [210, 160, 130] : [40, 40, 60]));
  const s = analyzePixels(data, W, H, null);
  assert.ok(s.face, 'face detected');
  assert.ok(Math.abs(s.face.x - 0.5) < 0.05 && Math.abs(s.face.y - 0.5) < 0.05);
  assert.ok(s.face.w > 0.1 && s.face.w < 0.5);
  const d = estimateDistance(s.face.w, 65);
  assert.ok(d > 0.1 && d < 2, `distance ${d}`);
  assert.ok(s.wb.every((g) => g > 0 && g <= 1));
  assert.equal(s.clipHi, 0);
});

test('grey world white balance corrects a blue cast', () => {
  const s = analyzePixels(frame(16, 9, () => [80, 100, 160]), 16, 9, null);
  assert.ok(s.wb[2] < s.wb[0] && s.wb[2] < s.wb[1], 'blue gain reduced');
  assert.ok(s.warmth < 0);
});

test('decision engine stays neutral without a scene and protects highlights', () => {
  const { params } = decide(null, { mode: 'natural', preset: 'natural', focal: 24, capture: 'photo' }, { hfov: 65, k1: 0.04 });
  assert.equal(params.mirror, 0); assert.equal(params.exposure, 1); assert.equal(params.persp, 0);
  const bright = analyzePixels(frame(16, 9, (x) => (x < 4 ? [255, 255, 255] : [60, 60, 60])), 16, 9, null);
  bright.aspect = 16 / 9;
  const r = decide(bright, { mode: 'natural', preset: 'natural', focal: 24, trueColor: 0.9, depth: true, natural: true, capture: 'photo' }, { hfov: 65, k1: 0.04 });
  assert.ok(r.params.exposure <= 1, 'no gain when highlights clip');
});

test('depth mapping re-projects a close face and never exceeds its cap', () => {
  const W = 96, H = 54;
  const close = analyzePixels(frame(W, H, (x, y) => (Math.hypot(x - 48, y - 27) < 22 ? [210, 160, 130] : [30, 30, 40])), W, H, null);
  close.aspect = W / H; close.face.conf = 1;
  const on = decide(close, { mode: 'portrait', preset: 'natural', focal: 50, depth: true, natural: true, capture: 'photo' }, { hfov: 65, k1: 0.04 });
  const off = decide(close, { mode: 'portrait', preset: 'natural', focal: 50, depth: false, natural: true, capture: 'photo' }, { hfov: 65, k1: 0.04 });
  assert.ok(on.distance < 0.8, `close distance ${on.distance}`);
  assert.ok(on.params.persp > 0 && on.params.persp <= 0.12);
  assert.equal(off.params.persp, 0);
});

test('mirror mode flips, video mode limits sharpening, aura is photo-only', () => {
  const s = analyzePixels(frame(16, 9, () => [120, 100, 90]), 16, 9, null); s.aspect = 16 / 9;
  assert.equal(decide(s, { mode: 'mirror', preset: 'natural', capture: 'photo' }, {}).params.mirror, 1);
  const v = decide(s, { mode: 'natural', preset: 'natural', natural: false, capture: 'video', aura: { on: true, dir: 'auto', strength: 1, skin: true } }, {});
  assert.ok(v.params.sharpen <= 0.6); assert.equal(v.aura, null);
  const p = decide(s, { mode: 'natural', preset: 'natural', natural: false, capture: 'photo', aura: { on: true, dir: 'cinematic', strength: 1, skin: true } }, {});
  assert.ok(p.aura && p.aura.dir === 'cinematic'); assert.ok(p.params.bgDesat > 0);
});

test('adaptive aura adapts to the scene and scales with strength', () => {
  const dark = { luma: 0.2, warmth: 0.2, contrast: 0.3, clipHi: 0, bgSat: 0.1, lightRatio: 4 };
  assert.equal(autoDirection(dark), 'cinematic');
  const bright = { luma: 0.6, warmth: 0, contrast: 0.1, clipHi: 0, bgSat: 0.1, lightRatio: 1 };
  assert.equal(autoDirection(bright), 'soft');
  const g1 = auraGrade(dark, { dir: 'auto', strength: 1, skin: true });
  const g0 = auraGrade(dark, { dir: 'auto', strength: 0, skin: true });
  assert.ok(g1.shadowTint[2] > 0, 'warm light gets cool shadows');
  assert.ok(g1.notes.some((n) => /warm light/.test(n)));
  assert.equal(g0.contrast, 0); assert.equal(g0.bgDesat, 0);
  const st = learnStyle([{ warmth: 0.1, saturation: 0.4, contrast: 0.25 }]);
  assert.ok(st.warmth > 0 && st.saturation > 0 && st.contrast > 0);
  assert.equal(learnStyle([]), null);
});

test('neutral params only carry orientation', () => {
  const n = neutralParams(true, 1.5);
  assert.equal(n.mirror, 1); assert.equal(n.k1, 0); assert.equal(n.sharpen, 0); assert.deepEqual(n.wb, [1, 1, 1]);
  assert.deepEqual(Object.keys(MODES), ['natural', 'mirror', 'cinematic', 'portrait']);
});

test('file names start with the 74 mark and are sanitised', () => {
  const d = new Date(2026, 9, 20, 9, 5, 7);
  assert.equal(makeFilename('74', 'natural', 'png', d), '74_truevision_natural_20261020_090507.png');
  assert.equal(makeFilename('../x/<y>', 'mirror', 'webm', d), 'xy_truevision_mirror_20261020_090507.webm');
  assert.equal(makeFilename('', 'film', 'mp4', d), '74_truevision_film_20261020_090507.mp4');
});

test('distance guidance', () => {
  assert.equal(distanceAdvice(null, 0.8).cls, '');
  assert.equal(distanceAdvice(0.8, 0.8).cls, 'ok');
  assert.match(distanceAdvice(0.5, 0.8).text, /move back about 30 cm/);
  assert.match(distanceAdvice(1.2, 0.8).text, /move closer about 40 cm/);
});
