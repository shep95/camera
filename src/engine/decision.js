// Adaptive decision engine.
// Combines the scene analysis with the user's intent (mode, preset, controls) and the priority
// weights, resolves conflicts between models and produces one set of rendering parameters.
import { estimateDistance } from './scene.js';
import { auraGrade } from './aura.js';

export const MODES = {
  natural:   { label: 'Natural',   sub: 'Natural Perspective',  mirror: false, filmic: 0.35, contrast: 1.00, saturation: 1.00, vignette: 0.00, warmth: 0.00, sharpen: 0.30, persp: 1.0 },
  mirror:    { label: 'Mirror',    sub: 'Familiar View',        mirror: true,  filmic: 0.35, contrast: 1.00, saturation: 1.00, vignette: 0.00, warmth: 0.00, sharpen: 0.30, persp: 1.0 },
  cinematic: { label: 'Cinematic', sub: 'Expressive Tone',      mirror: false, filmic: 1.00, contrast: 1.12, saturation: 0.92, vignette: 0.35, warmth: 0.04, sharpen: 0.30, persp: 1.0 },
  portrait:  { label: 'Portrait',  sub: 'Professional Quality', mirror: false, filmic: 0.70, contrast: 1.05, saturation: 1.03, vignette: 0.18, warmth: 0.02, sharpen: 0.35, persp: 1.25 },
};

export const PRESETS = {
  natural: { label: 'Natural' },
  soft:    { label: 'Soft',   sharpen: -0.45, contrast: -0.05, warmth: 0.02, highlightSoft: 0.3 },
  studio:  { label: 'Studio', exposure: 1.08, contrast: 0.06, warmth: 0.03, saturation: 0.03 },
  film:    { label: 'Film',   grain: 0.05, filmic: 0.3, saturation: -0.10, contrast: 0.05, warmth: 0.05, shadowLift: 0.03 },
};

export const DEFAULT_WEIGHTS = { geometry: 0.4, perception: 0.3, quality: 0.2, artistic: 0.1 };
const NATURAL_VIEW_DISTANCE = 1.2; // metres: a typical conversational viewing distance
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Neutral parameters: what the renderer does when everything is switched off (only orientation). */
export function neutralParams(mirror, aspect) {
  return { mirror: mirror ? 1 : 0, k1: 0, zoom: 1, face: [0.5, 0.5], faceR: 0, persp: 0, wb: [1, 1, 1], exposure: 1, contrast: 1, saturation: 1, warmth: 0,
    sharpen: 0, vignette: 0, grain: 0, filmic: 0, skin: 0, aspect, highlightSoft: 0, shadowLift: 0, shadowTint: [0, 0, 0], bgDesat: 0, skinProtect: 1, palette: 0 };
}

/**
 * @param scene   smoothed scene description from SceneAnalyzer (may be null before first frame)
 * @param ctl     { mode, preset, focal, distTarget, trueColor, depth, natural, capture, aura:{on,dir,strength,skin,style} }
 * @param cfg     { hfov, k1, weights }
 */
export function decide(scene, ctl, cfg) {
  const mode = MODES[ctl.mode] || MODES.natural;
  const preset = PRESETS[ctl.preset] || PRESETS.natural;
  const w = { ...DEFAULT_WEIGHTS, ...(cfg.weights || {}) };
  const wsum = w.geometry + w.perception + w.quality + w.artistic || 1;
  const wg = w.geometry / wsum, wp = w.perception / wsum, wq = w.quality / wsum, wa = w.artistic / wsum;
  const aspect = scene?.aspect || 16 / 9;
  const p = neutralParams(mode.mirror, aspect);
  const report = [];
  const add = (label, value, ref) => report.push({ label, value, ref });

  // --- Geometry model (16–30, 101–105) ---------------------------------------------------------
  const focal = clamp(ctl.focal || 24, 18, 85);
  const calib = ctl.calibration !== false, expo = ctl.exposureColor !== false;
  const k1 = calib ? (cfg.k1 ?? 0.04) * clamp(24 / focal, 0.4, 1.3) * clamp(wg / 0.4, 0.5, 1.5) : 0;
  const rmax2 = 0.25 * (aspect * aspect + 1);
  p.k1 = k1;
  const framingZoom = Math.max(1, 1 + (focal - 24) / 200);
  p.zoom = framingZoom * (k1 > 0 ? 1 / (1 + k1 * rmax2) : 1);
  add('Lens distortion k1', k1.toFixed(3), '13, 27');
  add('Equivalent focal', `${focal} mm (×${framingZoom.toFixed(2)} framing)`, '25, 26');

  let distance = null;
  if (scene?.face && scene.face.conf > 0.15) {
    distance = estimateDistance(scene.face.w, cfg.hfov || 65);
    p.face = [scene.face.x, scene.face.y];
    p.faceR = Math.max(scene.face.w * aspect, scene.face.h) * 0.78;
    if (ctl.depth && calib && distance) {
      // Close viewpoints exaggerate the nose and shrink the ears (perspective foreshortening).
      // Re-project toward a natural observer distance. Mild, local, and reversible.
      const exaggeration = Math.max(0, 1 / distance - 1 / NATURAL_VIEW_DISTANCE);
      let persp = exaggeration * 0.075 * mode.persp * clamp(focal / 50, 0.6, 1.6) * clamp(wg / 0.4, 0.5, 1.5);
      persp *= clamp(scene.face.conf, 0, 1);
      p.persp = clamp(persp, 0, 0.12);
      add('Face distance', `${distance.toFixed(2)} m`, '17–19, 101');
      add('Perspective re-projection', `${(p.persp * 100).toFixed(1)}% local`, '20, 30, 102');
    } else add('Face distance', distance ? `${distance.toFixed(2)} m` : '—', '101');
  } else add('Face', 'not found', '7. portrait model idle');

  // --- Exposure model (31–45) + perception (61–63, 73–74) ----------------------------------------
  if (scene) {
    const target = scene.face ? 0.42 : 0.40;
    const cur = Math.max(scene.face ? scene.faceLuma : scene.luma, 0.02);
    let e = clamp(target / cur, 0.7, 1.6);
    // Weber/Fechner: perceptual error grows with log ratio, so pull toward 1 as perception weight falls
    e = 1 + (e - 1) * clamp(wp / 0.3, 0.4, 1.2);
    if (scene.clipHi > 0.01) e = Math.min(e, 1);            // protect highlights (dynamic range)
    if (scene.clipHi > 0.03) e *= 0.93;
    // gain amplifies shot and read noise; the quality weight says how much that matters
    const noise = clamp(scene.noise, 0, 1);
    if (e > 1) e = 1 + (e - 1) * (1 - 0.6 * noise * clamp(wq / 0.2, 0.5, 1.5));
    if (!expo) e = 1;
    p.exposure = e * (preset.exposure || 1);
    if (ctl.lowLight && scene.luma < 0.3) { p.exposure = clamp(p.exposure * (0.35 / Math.max(scene.luma, 0.05)), 1, 2.6); add('Computational low-light', `${p.exposure.toFixed(2)}× gain, denoised (software, not night vision)`, '36–40'); }
    add('Exposure gain', `${p.exposure.toFixed(2)}×`, '31, 36–40, 61–62');
    add('Highlight clipping', `${(scene.clipHi * 100).toFixed(1)}%`, '37');
    add('Noise level', `${(noise * 100).toFixed(0)}%`, '38–40');

    // --- Color model (46–60) --------------------------------------------------------------------
    const tc = expo ? clamp(ctl.trueColor ?? 0.9, 0, 1) : 0;
    p.wb = scene.wb.map((g) => 1 + (g - 1) * tc * 0.85);
    p.skin = tc;
    add('White balance gains', p.wb.map((g) => g.toFixed(2)).join(' / '), '50–52');
    add('Scene warmth', scene.warmth.toFixed(2), '54');

    // --- Texture / portrait model (41–43, 112) ---------------------------------------------------
    let sharpen = mode.sharpen * (ctl.natural ? 0.8 : 1.6);
    sharpen *= 1 - 0.6 * noise;                               // sharpening would amplify noise
    sharpen += preset.sharpen || 0;
    if (ctl.capture === 'video') sharpen = Math.min(sharpen, 0.6); // temporal stability
    if (ctl.lowLight && scene.luma < 0.3) sharpen = Math.min(sharpen, -0.25); // denoise instead of sharpen
    p.sharpen = clamp(sharpen, -0.7, 1.2);
    add('Texture', p.sharpen >= 0 ? `+${(p.sharpen * 100).toFixed(0)}% micro-contrast` : `${(p.sharpen * 100).toFixed(0)}% soften`, '41–43, 112');
  }

  // --- Mode + preset styling (artistic weight scales anything beyond fidelity) --------------------
  const art = clamp(wa / 0.1, 0, 2);
  const style = (base, delta = 0) => base + delta * Math.min(1, art);
  p.filmic = clamp(style(mode.filmic, preset.filmic || 0), 0, 1);
  p.contrast = style(mode.contrast, preset.contrast || 0);
  p.saturation = style(mode.saturation, preset.saturation || 0);
  p.warmth = style(mode.warmth, preset.warmth || 0);
  p.vignette = mode.vignette * Math.min(1, art);
  p.grain = (preset.grain || 0) * Math.min(1, art);
  p.highlightSoft = preset.highlightSoft || 0;
  p.shadowLift = preset.shadowLift || 0;

  // --- Adaptive Aura: scene-aware colour grading (photos only, non-AI) ---------------------------
  let aura = null;
  if (ctl.aura?.on && ctl.capture === 'photo' && scene) {
    aura = auraGrade(scene, ctl.aura);
    p.contrast += aura.contrast; p.saturation += aura.saturation; p.warmth += aura.warmth;
    p.filmic = clamp(p.filmic + aura.filmic, 0, 1); p.vignette = clamp(p.vignette + aura.vignette, 0, 0.6);
    p.highlightSoft = clamp(p.highlightSoft + aura.highlightSoft, 0, 1);
    p.shadowLift = clamp(p.shadowLift + aura.shadowLift, 0, 0.12);
    p.shadowTint = aura.shadowTint; p.bgDesat = aura.bgDesat; p.skinProtect = ctl.aura.skin ? 1 : 0;
    add('Adaptive Aura', `${aura.name} · ${(ctl.aura.strength * 100).toFixed(0)}%`, '56, 59, 98–99');
  }
  p.contrast = clamp(p.contrast, 0.8, 1.3); p.saturation = clamp(p.saturation, 0.6, 1.3); p.warmth = clamp(p.warmth, -0.15, 0.15);
  p.palette = ['none', 'thermal-sim', 'night-sim', 'mono'].indexOf(ctl.palette || 'none'); if (p.palette < 0) p.palette = 0;
  if (p.palette) add('Palette', `${ctl.palette} — simulated visualization, not a measurement`, '56, 58');

  return { params: p, report, distance, aura, weights: { geometry: wg, perception: wp, quality: wq, artistic: wa } };
}

/** Distance guidance text (composition + portrait models). */
export function distanceAdvice(distance, target) {
  if (distance == null) return { text: 'Looking for a face…', cls: '' };
  const diff = distance - target;
  const cm = Math.round(Math.abs(diff) * 100);
  if (Math.abs(diff) < 0.08) return { text: `${distance.toFixed(2)} m · natural proportions`, cls: 'ok' };
  if (diff < 0) return { text: `${distance.toFixed(2)} m · move back about ${cm} cm`, cls: 'warn' };
  return { text: `${distance.toFixed(2)} m · move closer about ${cm} cm`, cls: 'warn' };
}
