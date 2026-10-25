// Scene analysis engine.
// Reads a low-resolution copy of the live frame and estimates lighting, colour, noise, motion and
// where the face is. Everything here is classical signal processing: no neural networks.

const AW = 96, AH = 54; // analysis resolution (16:9)

export class SceneAnalyzer {
  constructor() {
    this.canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(AW, AH) : Object.assign(document.createElement('canvas'), { width: AW, height: AH });
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.prevLuma = null;
    this.smooth = null; // temporally smoothed scene
    this.detector = (typeof FaceDetector !== 'undefined') ? new FaceDetector({ fastMode: true, maxDetectedFaces: 1 }) : null;
    this.detectorBusy = false;
    this.detected = null; // {x,y,w,h} in uv, from the platform face detector when available
  }

  /** Analyse a frame. Returns a smoothed scene description. */
  analyze(source, aspect) {
    const ctx = this.ctx;
    ctx.drawImage(source, 0, 0, AW, AH);
    const { data } = ctx.getImageData(0, 0, AW, AH);
    const n = AW * AH;
    const raw = analyzePixels(data, AW, AH, this.prevLuma);
    this.prevLuma = raw.lumaBuf;

    if (this.detector && !this.detectorBusy) {
      this.detectorBusy = true;
      this.detector.detect(source).then((faces) => {
        this.detectorBusy = false;
        if (faces && faces[0]) {
          const b = faces[0].boundingBox;
          const W = source.videoWidth || source.width, H = source.videoHeight || source.height;
          this.detected = { x: (b.x + b.width / 2) / W, y: (b.y + b.height / 2) / H, w: b.width / W, h: b.height / H, conf: 1, src: 'platform' };
        } else this.detected = null;
      }).catch(() => { this.detectorBusy = false; this.detector = null; });
    }
    const face = this.detected || raw.face;

    const scene = { ...raw, face, aspect, pixels: n };
    delete scene.lumaBuf;
    return this.temporal(scene);
  }

  /** Exponential smoothing so decisions do not flicker (temporal integration, principle 78). */
  temporal(s) {
    if (!this.smooth) { this.smooth = JSON.parse(JSON.stringify(s)); return this.smooth; }
    const a = s.motion > 0.08 ? 0.35 : 0.12; // adapt faster when the scene changes a lot
    const o = this.smooth;
    const lerp = (x, y) => x + (y - x) * a;
    o.luma = lerp(o.luma, s.luma); o.clipHi = lerp(o.clipHi, s.clipHi); o.clipLo = lerp(o.clipLo, s.clipLo);
    o.noise = lerp(o.noise, s.noise); o.motion = s.motion; o.contrast = lerp(o.contrast, s.contrast);
    o.sharpness = lerp(o.sharpness, s.sharpness);
    for (let i = 0; i < 3; i++) { o.mean[i] = lerp(o.mean[i], s.mean[i]); o.wb[i] = lerp(o.wb[i], s.wb[i]); o.bgMean[i] = lerp(o.bgMean[i], s.bgMean[i]); }
    o.bgSat = lerp(o.bgSat, s.bgSat); o.warmth = lerp(o.warmth, s.warmth);
    o.keyDir = lerp(o.keyDir, s.keyDir); o.lightRatio = lerp(o.lightRatio, s.lightRatio);
    if (s.face) {
      if (!o.face) o.face = { ...s.face };
      else { o.face.x = lerp(o.face.x, s.face.x); o.face.y = lerp(o.face.y, s.face.y); o.face.w = lerp(o.face.w, s.face.w); o.face.h = lerp(o.face.h, s.face.h); o.face.conf = lerp(o.face.conf, s.face.conf); o.face.src = s.face.src; }
      o.faceLuma = lerp(o.faceLuma ?? s.faceLuma, s.faceLuma);
      o.skinChroma = o.skinChroma ? [lerp(o.skinChroma[0], s.skinChroma[0]), lerp(o.skinChroma[1], s.skinChroma[1])] : s.skinChroma;
    } else if (o.face) { o.face.conf = lerp(o.face.conf, 0); if (o.face.conf < 0.05) o.face = null; }
    o.aspect = s.aspect;
    return o;
  }
}

/** Pure analysis of an RGBA buffer. Exported so it can be unit-tested without a browser. */
export function analyzePixels(data, W, H, prevLuma) {
  const n = W * H;
  let sr = 0, sg = 0, sb = 0, sl = 0, hi = 0, lo = 0;
  const lumaBuf = new Float32Array(n);
  // skin mask (YCbCr box, a classical heuristic)
  let sk = 0, skx = 0, sky = 0, skxx = 0, skyy = 0, skl = 0, skCb = 0, skCr = 0;
  const skin = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = data[p] / 255, g = data[p + 1] / 255, b = data[p + 2] / 255;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lumaBuf[i] = y; sr += r; sg += g; sb += b; sl += y;
    if (y > 0.97) hi++; if (y < 0.03) lo++;
    const cb = 0.5 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 0.5 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    if (cb > 0.30 && cb < 0.50 && cr > 0.52 && cr < 0.68 && y > 0.08 && y < 0.98) {
      const x = i % W, yy = (i / W) | 0;
      skin[i] = 1; sk++; skx += x; sky += yy; skxx += x * x; skyy += yy * yy; skl += y; skCb += cb; skCr += cr;
    }
  }
  const mean = [sr / n, sg / n, sb / n];
  const luma = sl / n;
  // gray-world white balance gains (colour constancy / chromatic adaptation, principles 50–52)
  const gm = (mean[0] + mean[1] + mean[2]) / 3 || 1e-3;
  const wb = [gm / Math.max(mean[0], 1e-3), gm / Math.max(mean[1], 1e-3), gm / Math.max(mean[2], 1e-3)];
  const wmax = Math.max(...wb); wb[0] /= wmax; wb[1] /= wmax; wb[2] /= wmax; // never amplify; scale others down
  const warmth = (mean[0] - mean[2]) / Math.max(gm, 1e-3); // >0 warm, <0 cool

  // face estimate: the most face-like CONNECTED skin region, not the mean of all skin pixels.
  // In warm light (lamps, sunsets, wood) walls and glows pass the skin test too; averaging them
  // makes the "face" cover half the frame and the distance estimate collapse.
  let face = null, faceLuma = luma, skinChroma = null;
  if (sk > n * 0.004) {
    // cut the mask along object outlines (strong brightness edges) so a face in front of a warm
    // wall or lamp glow does not merge with it into one region
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x; if (!skin[i]) continue;
      const g = Math.abs(lumaBuf[i + 1] - lumaBuf[i - 1]) + Math.abs(lumaBuf[i + W] - lumaBuf[i - W]);
      if (g > 0.07) skin[i] = 0;
    }
    const best = bestSkinRegion(skin, W, H, n);
    if (best) {
      const bw = best.maxX - best.minX + 3, bh = best.maxY - best.minY + 3; // +2: the edge cut trims about one pixel of rim per side
      face = { x: best.sx / best.n / W, y: best.sy / best.n / H, w: bw / W, h: bh / H, conf: Math.min(1, best.score * 3), src: 'skin' };
      // luma and chroma of the chosen region only
      let l = 0, cbs = 0, crs = 0;
      for (let i = 0, p = 0; i < n; i++, p += 4) if (skin[i] === best.label) {
        const r = data[p] / 255, g = data[p + 1] / 255, b = data[p + 2] / 255;
        l += 0.2126 * r + 0.7152 * g + 0.0722 * b; cbs += 0.5 - 0.168736 * r - 0.331264 * g + 0.5 * b; crs += 0.5 + 0.5 * r - 0.418688 * g - 0.081312 * b;
      }
      faceLuma = l / best.n; skinChroma = [cbs / best.n, crs / best.n];
    }
  }
  void skx; void sky; void skxx; void skyy; void skl; void skCb; void skCr;

  // noise proxy: high-frequency energy in flat regions; sharpness: Laplacian variance; local contrast
  let hf = 0, hfN = 0, lap = 0, lap2 = 0, lapN = 0;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    const c = lumaBuf[i];
    const l = 4 * c - lumaBuf[i - 1] - lumaBuf[i + 1] - lumaBuf[i - W] - lumaBuf[i + W];
    lap += l; lap2 += l * l; lapN++;
    const d = Math.abs(c - lumaBuf[i + 1]) + Math.abs(c - lumaBuf[i + W]);
    if (d < 0.06) { hf += d; hfN++; }
  }
  const noise = hfN ? (hf / hfN) / 0.06 : 0;
  const sharpness = lapN ? lap2 / lapN - (lap / lapN) ** 2 : 0;
  // global contrast: std of luma
  let v = 0; for (let i = 0; i < n; i++) v += (lumaBuf[i] - luma) ** 2; const contrast = Math.sqrt(v / n);

  // motion: mean absolute difference vs previous frame
  let motion = 0;
  if (prevLuma) { let m = 0; for (let i = 0; i < n; i++) m += Math.abs(lumaBuf[i] - prevLuma[i]); motion = m / n; }

  // background (non-skin) palette and key-light direction (left/right luma balance within the face)
  let br = 0, bg = 0, bb = 0, bn = 0, bsat = 0, lL = 0, lR = 0, nL = 0, nR = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (!skin[i]) {
      const r = data[p] / 255, g = data[p + 1] / 255, b = data[p + 2] / 255;
      br += r; bg += g; bb += b; bn++;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b); bsat += mx > 0 ? (mx - mn) / mx : 0;
    } else if (face) {
      const x = (i % W) / W; if (x < face.x) { lL += lumaBuf[i]; nL++; } else { lR += lumaBuf[i]; nR++; }
    }
  }
  const bgMean = bn ? [br / bn, bg / bn, bb / bn] : mean.slice();
  const bgSat = bn ? bsat / bn : 0;
  const keyDir = nL && nR ? (lL / nL - lR / nR) : 0; // >0 key from subject's left side of frame
  const lightRatio = nL && nR ? Math.max(lL / nL, lR / nR) / Math.max(Math.min(lL / nL, lR / nR), 1e-3) : 1;

  return { mean, luma, clipHi: hi / n, clipLo: lo / n, wb, warmth, face, faceLuma, skinChroma, noise, sharpness, contrast, motion, bgMean, bgSat, keyDir, lightRatio, lumaBuf };
}

/**
 * Label 4-connected skin regions in place (mask values become labels 2..) and return the region
 * that best resembles a face: large enough, near the upper-centre of the frame, ellipse-like fill,
 * and taller than wide. Returns null when nothing plausible exists.
 */
export function bestSkinRegion(mask, W, H, n = W * H) {
  const stack = new Int32Array(n); let label = 1, best = null;
  for (let s0 = 0; s0 < n; s0++) {
    if (mask[s0] !== 1) continue;
    label++; let sp = 0; stack[sp++] = s0; mask[s0] = label;
    const c = { label, n: 0, sx: 0, sy: 0, minX: W, maxX: 0, minY: H, maxY: 0 };
    while (sp) {
      const i = stack[--sp], x = i % W, y = (i / W) | 0;
      c.n++; c.sx += x; c.sy += y;
      if (x < c.minX) c.minX = x; if (x > c.maxX) c.maxX = x; if (y < c.minY) c.minY = y; if (y > c.maxY) c.maxY = y;
      if (x > 0 && mask[i - 1] === 1) { mask[i - 1] = label; stack[sp++] = i - 1; }
      if (x < W - 1 && mask[i + 1] === 1) { mask[i + 1] = label; stack[sp++] = i + 1; }
      if (y > 0 && mask[i - W] === 1) { mask[i - W] = label; stack[sp++] = i - W; }
      if (y < H - 1 && mask[i + W] === 1) { mask[i + W] = label; stack[sp++] = i + W; }
    }
    if (c.n < n * 0.004) continue;
    const bw = c.maxX - c.minX + 1, bh = c.maxY - c.minY + 1;
    const fill = c.n / (bw * bh);                         // an ellipse fills ~0.79 of its box
    const aspect = (bh / H) / (bw / W) * (H / W);         // pixel aspect h/w; faces ~1.1–1.6
    const cx = c.sx / c.n / W, cy = c.sy / c.n / H;
    const central = Math.max(0, 1 - 1.3 * Math.hypot(cx - 0.5, (cy - 0.45) * 1.2));
    const shape = Math.exp(-(((fill - 0.75) / 0.25) ** 2)) * Math.exp(-(((aspect - 1.3) / 0.6) ** 2));
    const size = Math.min(1, c.n / (n * 0.04));
    const edges = (c.minX === 0) + (c.maxX === W - 1) + (c.minY === 0) + (c.maxY === H - 1);
    const border = edges >= 2 ? 0.3 : edges === 1 ? 0.8 : 1; // walls and glows touch the frame; faces rarely touch two edges
    c.score = size * (0.25 + 0.75 * central) * (0.2 + 0.8 * shape) * border;
    if (!best || c.score > best.score) best = c;
  }
  return best && best.score > 0.05 ? best : null;
}

/** Estimate camera-to-subject distance from the face width in uv units (pinhole model, principles 17–19, 101). */
export function estimateDistance(faceW, hfovDeg, realFaceWidthM = 0.15) {
  if (!faceW || faceW <= 0) return null;
  const halfTan = Math.tan((hfovDeg * Math.PI) / 360);
  return realFaceWidthM / (faceW * 2 * halfTan);
}
