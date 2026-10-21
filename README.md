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

The seven models (optics, geometry, exposure, colour, perception, composition, portrait) and the
115 principles they draw on are catalogued in `src/engine/principles.js`. They are not 115 filters:
the models share one scene representation and the decision engine resolves their conflicts with the
priority weights (geometry & colour 40 %, perception 30 %, image quality 20 %, artistic 10 % by
default, adjustable in Settings). The **ⓘ** button shows the live engine report.

## Controls

- **Modes**: Natural · Mirror · Cinematic · Portrait. **Presets**: Natural · Soft · Studio · Film.
- **Focal Length** (equivalent rendering), **Distance Guide** (target distance; the viewfinder tells you how far you are and which way to move), **True Color**, **Depth Mapping**, **Natural Processing**, **Adaptive Aura**.
- Keyboard: `Space` capture · `P`/`V` photo/video · `M` mirror · `G` framing guide · hold `C` to compare.
- Settings: camera, resolution, file prefix, field of view and lens-distortion calibration, reference frames, microphone, priority weights.

## Honest limits

A webcam gives optical calibration, exposure analysis, colour correction, texture control, framing
guidance and approximate depth/perspective estimation. A single flat photograph cannot reproduce
binocular depth, accommodation or motion parallax; the most faithful version would need
stereoscopic capture or a depth-aware display. Distance estimation assumes an average face width
and the configured field of view; calibrate the field of view in Settings for your camera.
