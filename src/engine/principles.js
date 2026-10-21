// The 115 laws and principles that inform the True Vision engine, grouped into the seven models.
// They are not 115 filters: the scene analysis engine uses them to understand the scene, the
// decision engine uses them to pick trade-offs, and the renderer applies the chosen corrections.

export const GROUPS = [
  { id: 'optics', model: 1, name: 'Optics & light', range: [1, 15], understands: 'lens behaviour, reflections, scattering, diffraction', does: 'corrects calibrated lens defects and accounts for optical limits' },
  { id: 'geometry', model: 2, name: 'Camera geometry', range: [16, 30], understands: 'distance, perspective, depth, viewpoint', does: 'corrects lens distortion and reconstructs perspective where data permits' },
  { id: 'exposure', model: 3, name: 'Exposure & image formation', range: [31, 45], understands: 'photons, noise, shutter timing, dynamic range', does: 'balances exposure, detail, motion blur and noise' },
  { id: 'color', model: 4, name: 'Color', range: [46, 60], understands: 'illumination, spectral response, human colour perception', does: 'estimates white balance and renders calibrated colours' },
  { id: 'perception', model: 5, name: 'Visual perception', range: [61, 80], understands: 'brightness adaptation, depth cues, attention', does: 'adjusts rendering for a defined human viewing condition' },
  { id: 'composition', model: 6, name: 'Composition', range: [81, 100], understands: 'balance, framing, hierarchy, negative space', does: 'offers framing guidance without forcing artistic changes' },
  { id: 'portrait', model: 7, name: 'Portrait', range: [101, 115], understands: 'facial geometry, lighting, expression, skin detail', does: 'preserves identity while optimising capture and rendering' },
];

export const PRINCIPLES = [
  'law of reflection', "snell's law of refraction", 'inverse-square law of light', 'inverse-square law of illumination',
  'law of conservation of energy', 'beer–lambert law', 'fresnel equations', 'diffraction', 'interference', 'polarization',
  'chromatic aberration', 'spherical aberration', 'optical distortion', 'vignetting', 'lens flare and scattering',
  'perspective projection', 'pinhole camera model', 'thin-lens equation', 'magnification law', 'perspective foreshortening',
  'parallax', 'depth of field', 'hyperfocal distance', 'circle of confusion', 'field of view', 'focal length and framing',
  'lens distortion models', 'stereo triangulation', 'epipolar geometry', 'perspective transformation',
  'exposure triangle', 'exposure reciprocity', 'reciprocity failure', 'f-number relationship', 'shutter speed and motion blur',
  'ISO sensitivity and gain', 'dynamic range', 'signal-to-noise ratio', 'photon shot noise', 'sensor read noise',
  'diffraction-limited resolution', 'nyquist–shannon sampling theorem', 'modulation transfer function', 'quantization', 'rolling shutter effect',
  'additive color mixing', 'subtractive color mixing', 'trichromatic theory', 'opponent-process theory', 'color constancy',
  'chromatic adaptation', 'white balance', 'metamerism', 'color temperature', 'spectral sensitivity', 'tone mapping',
  'gamma encoding', 'color gamut', 'color difference', 'simultaneous color contrast',
  "weber's law", "fechner's law", "stevens' power law", 'gestalt law of proximity', 'gestalt law of similarity',
  'gestalt law of closure', 'gestalt law of continuity', 'gestalt law of common fate', 'figure–ground organization',
  'binocular disparity', 'stereopsis', 'motion parallax', 'visual adaptation', 'brightness constancy', 'perceptual organization',
  'selective attention', 'visual salience', 'temporal integration', 'perceptual familiarity', 'face inversion effect',
  'rule of thirds', 'golden ratio', 'golden spiral', 'leading lines', 'symmetry', 'asymmetrical balance', 'visual hierarchy',
  'negative space', 'framing', 'depth layering', 'foreground–background separation', 'contrast', 'repetition and rhythm',
  'patterns', 'visual weight', 'subject isolation', 'perspective and viewpoint', 'color harmony', 'tonal balance', 'simplicity',
  'camera-to-subject distance', 'facial perspective distortion', 'camera height and angle', 'head orientation',
  'facial symmetry and asymmetry', 'key lighting', 'fill lighting', 'rim lighting', 'lighting ratio', 'catchlights',
  'shadow modeling', 'skin texture preservation', 'expression timing', 'pose and body geometry', 'background separation',
];

export function principle(n) { return `${n}. ${PRINCIPLES[n - 1] || '?'}`; }
export function groupOf(n) { return GROUPS.find((g) => n >= g.range[0] && n <= g.range[1]); }
