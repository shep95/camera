// Feature registry: every capability of the platform, grouped by domain, each with its own switch.
// Domains mirror the architecture: device system, image processing, optical intelligence,
// observation system, presentation, recording, privacy.

export const DOMAINS = [
  { id: 'device', name: 'Device system', desc: 'Discovery, capability manifests and multi-source coordination.' },
  { id: 'processing', name: 'Image processing', desc: 'Measurement-preserving corrections and presentation processing.' },
  { id: 'intelligence', name: 'Optical intelligence (non-AI)', desc: 'Deterministic motion analysis, tracking, attention and adaptive focus. No learned models.' },
  { id: 'observation', name: 'Observation system', desc: 'Temporary snapshots and a timeline of tracking events. Never writes to your photo folders.' },
  { id: 'presentation', name: 'Presentation', desc: 'Overlays, focus windows, palettes and guides.' },
  { id: 'recording', name: 'Recording', desc: 'Photo, video, desktop and workspace recording.' },
  { id: 'privacy', name: 'Privacy', desc: 'Indicators, retention and identification controls.' },
];

export const FEATURES = {
  device: {
    enabled: [true, 'Device system', 'Master switch for this domain.'],
    discovery: [true, 'Camera discovery', 'List connected cameras and build capability manifests.'],
    verify: [true, 'Capability verification', 'Allow opening a device on request to test resolutions and controls.'],
    multiCamera: [true, 'Multi-camera workspace', 'Show several sources in one synchronized grid.'],
    screenSource: [true, 'Desktop as a source', 'Allow screen, window or tab capture as a source.'],
  },
  processing: {
    enabled: [true, 'Image processing', 'Master switch for this domain.'],
    calibration: [true, 'Optical calibration', 'Lens distortion correction and framing from the focal-length setting.'],
    exposureColor: [true, 'Exposure & colour', 'Face-targeted exposure, white balance and skin-tone calibration.'],
    depth: [true, 'Depth mapping', 'Perspective re-projection toward a natural observer distance.'],
    natural: [true, 'Natural processing', 'Texture-preserving detail instead of aggressive sharpening.'],
    aesthetics: [true, 'Adaptive Aura', 'Scene-aware colour grading for photos (switch on in the panel).'],
    lowLight: [false, 'Computational low-light', 'Extra gain and denoising for dark scenes. Software only: not night vision, cannot recover what the sensor never captured.'],
    stabilization: [true, 'Camera-motion compensation', 'Estimate global camera motion so tracking and focus windows stay on target.'],
  },
  intelligence: {
    enabled: [true, 'Optical intelligence', 'Master switch for this domain.'],
    motion: [true, 'Motion detection', 'Frame differencing against a running background model.'],
    objects: [true, 'Moving-object tracking', 'Connected components with constant-velocity prediction. Tracks changes, does not name objects.'],
    trajectories: [true, 'Trajectory visualization', 'Draw estimated paths through the image (image coordinates, not metres).'],
    region: [true, 'Region monitoring', 'Watch a user-drawn rectangle for activity.'],
    events: [false, 'Event recording', 'Save a short clip (with the 74 mark) when a significant target is acquired.'],
    particles: [true, 'Particle view', 'Enhance and trace small bright transient features. A visualization of optical signals, not a particle count.'],
    frequency: [true, 'Frequency seer (optical)', 'Brightness-over-time spectrum, limited to half the frame rate.'],
    autoFocus: [true, 'Adaptive focus', 'Magnified, tracked focus windows on significant details (and manual windows on click).'],
    attention: [true, 'Attention scoring', 'Deterministic score from motion, contrast, persistence, template match and noise.'],
  },
  observation: {
    enabled: [true, 'Observation system', 'Master switch for this domain.'],
    log: [true, 'Observation history', 'Keep original observed crops with timestamps and tracking metadata.'],
    autoCapture: [true, 'Automatic observations', 'Add an observation when a target is acquired, lost or a region shows activity.'],
  },
  presentation: {
    enabled: [true, 'Presentation', 'Master switch for this domain.'],
    focusWindows: [true, 'Focus window overlays', 'Show rounded magnification windows over the viewfinder.'],
    overlays: [true, 'Analysis overlays', 'Boxes, trajectories and particle traces over the live image.'],
    faceBox: [true, 'Face framing box', 'Show the estimated face region when the framing guide is on.'],
    palettes: [true, 'Visualization palettes', 'Simulated thermal-style and night-style palettes, always labelled as simulated.'],
    ambient: [true, 'Adaptive interface colour', 'Let the scene tint the interface.'],
  },
  recording: {
    enabled: [true, 'Recording', 'Master switch for this domain.'],
    photo: [true, 'Photo capture', 'Six-frame burst, sharpest frame kept.'],
    video: [true, 'Video recording', 'Record the processed view.'],
    referenceFrames: [false, 'Reference frames', 'Also save an unprocessed frame with each photo.'],
    screen: [true, 'Desktop recording', 'Record a screen, window or tab with a camera overlay.'],
    workspace: [true, 'Workspace recording', 'Record the synchronized grid or each stream independently.'],
    audio: [true, 'Microphone audio', 'Include the microphone in recordings.'],
  },
  privacy: {
    enabled: [true, 'Privacy', 'Master switch for this domain.'],
    indicator: [true, 'Recording indicator', 'Always show a visible badge while recording.'],
    faceId: [false, 'Face identification', 'Not implemented. True Vision never identifies people; this switch cannot be turned on.'],
    localOnly: [true, 'Local-only processing', 'All analysis runs on this device. There is no network path for frames.'],
  },
};

export function defaultFeatures() {
  const out = {};
  for (const d of Object.keys(FEATURES)) { out[d] = {}; for (const [k, v] of Object.entries(FEATURES[d])) out[d][k] = v[0]; }
  return out;
}

/** Accept only known domain/feature keys with boolean values; hard-locked features keep their defaults. */
export function sanitizeFeatures(raw) {
  const out = defaultFeatures();
  if (!raw || typeof raw !== 'object') return out;
  for (const d of Object.keys(out)) {
    const rd = raw[d]; if (!rd || typeof rd !== 'object') continue;
    for (const k of Object.keys(out[d])) if (typeof rd[k] === 'boolean') out[d][k] = rd[k];
  }
  out.privacy.faceId = false; out.privacy.localOnly = true;
  return out;
}

/** Is a feature effectively on (its own switch and the domain master)? */
export function featureOn(f, domain, key) { return !!(f?.[domain]?.enabled && f?.[domain]?.[key]); }
