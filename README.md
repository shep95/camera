# True Vision Camera

**See yourself as others do.** A physics-aware, perception-aware computational camera that runs
in the browser on any device, online or offline. It does not beautify the face: it minimises the
differences introduced by camera perspective, optics, lighting, image processing and the flat display.

No frameworks, no dependencies, no AI models, no network calls at runtime. Every frame is analysed
and rendered on your device; nothing leaves it.

## Run it

```bash
npm start          # → http://localhost:7400
npm test           # unit tests for the engine (Node ≥ 18)
```

Or deploy the folder to any static host (a `vercel.json` with hardened security headers is included).
After the first visit the service worker caches the app, so it keeps working with no connection.

## What it does

| limitation of ordinary cameras | what True Vision does |
| --- | --- |
| mirrored vs. unmirrored face | **Natural** (unmirrored, how others see you) and **Mirror** modes, with a true preview; optional mirror-preview-only while the file stays true |
| facial distortion | face distance estimated from the pinhole model; **Depth Mapping** re-projects a too-close viewpoint toward a natural observer distance, mildly, locally and reversibly |
| missing depth | face-local perspective correction + depth cues (vignette, separation) in Cinematic/Portrait |
| unnatural skin and colours | grey-world white balance (colour constancy) and **True Color** skin-chroma calibration |
| excessive sharpening | **Natural Processing** keeps real texture; micro-contrast is reduced automatically when noise rises |
| frozen expressions | the shutter captures a 6-frame burst and keeps the sharpest (Laplacian variance) |
| lighting mismatch | exposure targeted on the face, highlight protection, gentle highlight shoulder, filmic tone only when asked |

Captures are saved to the device by the browser with the **`74`** mark at the start of the file
name: `74_truevision_<mode>_<date>_<time>.png` for photos and `.webm` for video. Optionally, an
unprocessed reference frame is saved beside each photo for comparison.

### Adaptive Aura (photos only, non-AI)

A scene-aware colour grade that builds a look for the current scene instead of applying a fixed
filter. It reads the lighting (warmth, key/fill ratio, clipping), the background palette and
saturation, and the overall contrast, then chooses the grade: cool shadow tint under warm light,
softened highlights, background desaturation for separation, open shadows in dark rooms. Skin tones
are protected, facial structure is never touched, and "Hold to compare" shows the original output.
"Learn my style" reads warmth, saturation and contrast statistics from photos you pick and biases
the grade toward them. It is inactive in video mode.

## An adaptive visual platform, not just a camera app

True Vision is organised as a visual intelligence platform that recognises connected hardware,
determines what it can actually sense, and exposes only the processing that can genuinely run.
Its foundational rule: **detect what exists, understand what is measurable, transform what is
supported, visualize what is inferred, never confuse a visualization with a direct observation.**

| subsystem | what it does | honest limits |
| --- | --- | --- |
| **Device system** | discovers cameras, builds a capability manifest per device separating *reported* (driver) from *verified* (tested by opening the device), guesses modality from the name only, exports the manifest as JSON | a browser cannot read the bus or the sensor physics; thermal/infrared/depth are never claimed, only flagged "by name, unverified" |
| **Optical intelligence (non-AI)** | frame differencing with a running background model, global camera-motion compensation, connected components, constant-velocity tracking with predict/lost/reacquire/release states, deterministic attention score `S = wm·M + wc·C + wp·P + wt·T − wn·N`, trajectory overlay, region monitoring, event clips | tracks *changes*, it does not name objects; pixel motion is not metres per second |
| **Adaptive focus** | rounded, draggable magnification windows that follow a tracked target (auto-opened above the attention threshold, or opened by clicking the image), with stabilization, pinning and a frozen "last observed" view when the target is lost | magnification enlarges captured pixels only; it cannot reveal detail the sensor never recorded |
| **Particle view** | enhances and traces small bright transient features over time | a visualization of optical signals, not a particle count and not a composition |
| **Frequency seer** | brightness-over-time spectrum of the camera signal, labelled *measured*; an optional wave animation labelled *illustrative* | limited to half the frame rate; a visible-light camera does not measure radio-frequency fields; no external sensor is connected |
| **Observation system** | timeline of acquired / lost / reacquired / region / manual events with the *original* observed crop, session-only memory or private IndexedDB history with retention and delete; export is explicit and file-based | never writes to your photo folders on its own |
| **Workspace** | up to four sources (cameras, the primary feed, a screen) in one grid on a shared clock, drag to reorder, maximize, per-tile record choice, synchronized and/or independent recording | starting streams together is not frame-level sync; timestamps are shown on the composed recording |
| **Screen recorder** | the desktop is a first-class source: screen, window or tab, camera overlay as a composited layer (shape, size, opacity, drag with corner snapping), microphone and system audio mixed, pause/resume, WebM export | cursor highlighting and keystroke display are not exposed to web pages |
| **Palettes** | thermal-style, night-style and mono visualizations | always labelled **simulated**; never a temperature measurement |
| **Computational low-light** | extra gain and denoising in dark scenes | software only, not night vision |

Every feature has its own switch under its domain in **Settings → Features by domain**, and each
domain has a master switch. Face identification is not implemented and its switch cannot be turned on.
Analysis always runs on the original frames, never on the stylized output, so the aesthetic engine
cannot invent details that the tracker mistakes for objects.

## Architecture

```
live camera frame
   │
   ▼
scene analysis engine      src/engine/scene.js      lighting · colour · noise · motion · face · distance
   │
   ▼
adaptive decision engine   src/engine/decision.js   seven models + priority weights → one parameter set
   │        └─ adaptive aura src/engine/aura.js     scene-aware grade (photo only)
   ▼
renderer (WebGL)           src/engine/renderer.js   one shader: geometry → texture → colour → perception
   │
   ▼
capture                    src/engine/capture.js    burst selection · recording · saving with the 74 mark
```

Platform modules: `src/engine/devices.js` (device system), `src/engine/vision.js` (motion, tracking,
attention, particles, flicker), `src/engine/focus.js` (adaptive focus), `src/engine/observations.js`
(observation history), `src/engine/workspace.js` (multi-camera grid), `src/engine/screenrec.js`
(desktop recording), `src/features.js` (feature registry and switches), `src/platform.js` (UI wiring).

The seven models (optics, geometry, exposure, colour, perception, composition, portrait) and the
115 principles they draw on are catalogued in `src/engine/principles.js`. They are not 115 filters:
the models share one scene representation and the decision engine resolves their conflicts with the
priority weights (geometry & colour 40 %, perception 30 %, image quality 20 %, artistic 10 % by
default, adjustable in Settings). The **ⓘ** button shows the live engine report.

## Controls

- **Modes**: Natural · Mirror · Cinematic · Portrait. **Presets**: Natural · Soft · Studio · Film.
- **Focal Length** (equivalent rendering), **Distance Guide** (target distance; the viewfinder tells you how far you are and which way to move), **True Color**, **Depth Mapping**, **Natural Processing**, **Adaptive Aura**.
- Tool dock (right edge of the viewfinder): adaptive focus · motion overlay · region monitoring · particle view · frequency seer · observation history · workspace · screen recorder · palette.
- Keyboard: `Space` capture · `P`/`V` photo/video · `M` mirror · `G` framing guide · hold `C` to compare.
- Settings: camera, resolution, file prefix, field of view and lens-distortion calibration, reference frames, microphone, priority weights.

## Honest limits

A webcam gives optical calibration, exposure analysis, colour correction, texture control, framing
guidance and approximate depth/perspective estimation. A single flat photograph cannot reproduce
binocular depth, accommodation or motion parallax; the most faithful version would need
stereoscopic capture or a depth-aware display. Distance estimation assumes an average face width
and the configured field of view; calibrate the field of view in Settings for your camera.
