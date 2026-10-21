// Adaptive Aura — scene-aware colour grading. Photos only. Non-AI: it is a set of rules driven by
// scene statistics. A normal filter applies one fixed look; this builds a look for the current scene.
// It has two independent objectives: identity fidelity (never touches geometry or skin structure)
// and aesthetic coherence (a tonal treatment that complements subject and environment).

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const DIRECTIONS = {
  cinematic: { name: 'Cinematic', contrast: 0.12, saturation: -0.08, filmic: 0.5, vignette: 0.28, highlightSoft: 0.30, shadowLift: 0.00, bgDesat: 0.30, shadowCool: 0.045, warmth: 0.02 },
  soft:      { name: 'Soft',      contrast: -0.08, saturation: -0.04, filmic: 0.2, vignette: 0.05, highlightSoft: 0.55, shadowLift: 0.04, bgDesat: 0.15, shadowCool: -0.015, warmth: 0.025 },
  editorial: { name: 'Editorial', contrast: 0.08, saturation: -0.12, filmic: 0.3, vignette: 0.10, highlightSoft: 0.15, shadowLift: 0.01, bgDesat: 0.42, shadowCool: 0.010, warmth: -0.01 },
};

/** Pick a direction from the scene when the user chooses "auto". */
export function autoDirection(scene) {
  const dark = scene.luma < 0.28, bright = scene.luma > 0.55;
  const warm = scene.warmth > 0.12, lowContrast = scene.contrast < 0.16, highContrast = scene.contrast > 0.26;
  if (dark && (warm || highContrast)) return 'cinematic';
  if (bright && lowContrast) return 'soft';
  if (highContrast || scene.bgSat > 0.35) return 'editorial';
  return scene.luma < 0.4 ? 'cinematic' : 'soft';
}

/**
 * @param scene  smoothed scene statistics
 * @param opts   { dir: 'auto'|'cinematic'|'soft'|'editorial', strength: 0..1, skin: bool, style: {warmth,saturation,contrast}|null }
 */
export function auraGrade(scene, opts) {
  const dir = opts.dir === 'auto' || !DIRECTIONS[opts.dir] ? autoDirection(scene) : opts.dir;
  const d = DIRECTIONS[dir];
  const s = clamp(opts.strength ?? 0.65, 0, 1);
  const notes = [];

  // start from the direction's intent, then adapt each term to what the scene already has
  let contrast = d.contrast, saturation = d.saturation, warmth = d.warmth, filmic = d.filmic, vignette = d.vignette;
  let highlightSoft = d.highlightSoft, shadowLift = d.shadowLift, bgDesat = d.bgDesat, shadowCool = d.shadowCool;

  if (scene.contrast > 0.26) { contrast -= 0.08; notes.push('scene already contrasty: contrast eased'); }
  if (scene.contrast < 0.14 && dir !== 'soft') { contrast += 0.05; notes.push('flat light: contrast lifted a little'); }
  if (scene.clipHi > 0.01) { highlightSoft += 0.25; notes.push('bright highlights softened'); }
  if (scene.luma < 0.25) { shadowLift += 0.02; highlightSoft += 0.1; notes.push('dark scene: shadows kept open'); }
  if (scene.bgSat > 0.3) { bgDesat += 0.15; notes.push('busy background desaturated for separation'); }
  // colour harmony: a warm key light reads deeper with slightly cool shadows (complementary), and vice versa
  if (scene.warmth > 0.12) { shadowCool += 0.02; warmth -= 0.01; notes.push('warm light: cool shadow tint for depth'); }
  else if (scene.warmth < -0.08) { shadowCool -= 0.03; warmth += 0.02; notes.push('cool light: warm shadow tint'); }
  if (scene.lightRatio > 3) { contrast -= 0.04; shadowLift += 0.015; notes.push('strong key/fill ratio: shadows opened'); }

  // learned style: statistics from photos the user picked (no AI; mean warmth/saturation/contrast)
  if (opts.style) {
    warmth += clamp(opts.style.warmth, -0.08, 0.08) * 0.5;
    saturation += clamp(opts.style.saturation, -0.15, 0.15) * 0.5;
    contrast += clamp(opts.style.contrast, -0.1, 0.1) * 0.5;
    notes.push('biased toward your learned style');
  }

  const sc = (v) => v * s || 0; // scale by strength (and normalise -0)
  const shadowTint = [-shadowCool * 0.5, -shadowCool * 0.2, shadowCool].map(sc);
  return {
    name: d.name + (opts.dir === 'auto' ? ' (auto)' : ''), dir, notes,
    contrast: sc(contrast), saturation: sc(saturation), warmth: sc(warmth), filmic: sc(filmic), vignette: sc(vignette),
    highlightSoft: sc(highlightSoft), shadowLift: sc(shadowLift), bgDesat: sc(clamp(bgDesat, 0, 0.7)), shadowTint,
  };
}

/**
 * Learn a style from reference images: returns deltas relative to neutral baselines.
 * `stats` is a list of { warmth, saturation, contrast } from analysePixels-style measurements.
 */
export function learnStyle(stats) {
  if (!stats.length) return null;
  const avg = (k) => stats.reduce((a, b) => a + b[k], 0) / stats.length;
  return { warmth: avg('warmth') - 0.0, saturation: avg('saturation') - 0.30, contrast: avg('contrast') - 0.20, count: stats.length };
}
