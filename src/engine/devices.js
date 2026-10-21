// Device system: discovery, capability manifests, verification.
// A browser cannot read a device's transport or sensor physics. The manifest therefore separates
// what the driver REPORTS (getCapabilities) from what has been VERIFIED by opening the device,
// and it only guesses a modality from the device name, clearly marked as unverified.

export class DeviceManager extends EventTarget {
  constructor() { super(); this.devices = []; this.manifests = new Map(); this.onChange = () => this.refresh(); }
  start() { navigator.mediaDevices?.addEventListener?.('devicechange', this.onChange); return this.refresh(); }
  stop() { navigator.mediaDevices?.removeEventListener?.('devicechange', this.onChange); }

  async refresh() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    let list = [];
    try { list = await navigator.mediaDevices.enumerateDevices(); } catch { list = []; }
    this.devices = list.filter((d) => d.kind === 'videoinput' || d.kind === 'audioinput');
    for (const d of this.devices.filter((x) => x.kind === 'videoinput')) {
      const id = d.deviceId || `anon-${this.devices.indexOf(d)}`;
      const m = this.manifests.get(id) || this.blankManifest(id);
      m.name = d.label || m.name; m.modality = guessModality(d.label);
      if (typeof d.getCapabilities === 'function') { try { m.reported = summarizeCaps(d.getCapabilities()); } catch { /* not supported */ } }
      this.manifests.set(id, m);
    }
    this.dispatchEvent(new Event('change'));
    return this.devices;
  }

  blankManifest(id) {
    return {
      device_id: id, name: 'camera', transport: 'unknown (browser cannot read the bus)',
      sensor_modalities: ['visible_light'], modality: { guess: 'visible_light', verified: false },
      reported: null, verified: { resolutions: [], controls: [], tested_at: null },
      capabilities: { thermal: false, infrared: false, radiometric: false, night_enhancement: true, motion_detection: true, object_tracking: true, optical_flicker: true, face_identification: false },
      notes: ['night_enhancement, motion_detection and object_tracking are host-side software capabilities, not sensor capabilities.'],
    };
  }

  /** Record what an open track reports (cheap, no new permission prompt). */
  noteTrack(track) {
    const s = track.getSettings?.() || {}; const id = s.deviceId; if (!id) return;
    const m = this.manifests.get(id) || this.blankManifest(id); this.manifests.set(id, m);
    if (typeof track.getCapabilities === 'function') { try { m.reported = summarizeCaps(track.getCapabilities()); } catch { /* unsupported */ } }
    if (s.width && s.height) addUnique(m.verified.resolutions, `${s.width}x${s.height}${s.frameRate ? `@${Math.round(s.frameRate)}` : ''}`);
    m.verified.tested_at = new Date().toISOString();
    this.dispatchEvent(new Event('change'));
  }

  /** Verify resolutions and controls by actually opening the device (user-initiated only). */
  async verify(deviceId) {
    const m = this.manifests.get(deviceId) || this.blankManifest(deviceId); this.manifests.set(deviceId, m);
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } });
      const track = stream.getVideoTracks()[0];
      for (const [w, h] of [[3840, 2160], [1920, 1080], [1280, 720], [640, 480]]) {
        try { await track.applyConstraints({ width: { exact: w }, height: { exact: h } }); const s = track.getSettings(); addUnique(m.verified.resolutions, `${s.width}x${s.height}`); } catch { /* unsupported */ }
      }
      const caps = typeof track.getCapabilities === 'function' ? track.getCapabilities() : {};
      for (const c of ['exposureMode', 'exposureCompensation', 'focusMode', 'focusDistance', 'whiteBalanceMode', 'colorTemperature', 'iso', 'brightness', 'contrast', 'saturation', 'sharpness', 'zoom', 'torch', 'pan', 'tilt']) {
        if (c in caps) addUnique(m.verified.controls, c);
      }
      m.verified.tested_at = new Date().toISOString();
    } catch (e) { m.notes.push(`verification failed: ${e.name || e.message}`); }
    finally { stream?.getTracks().forEach((t) => t.stop()); }
    this.dispatchEvent(new Event('change'));
    return m;
  }

  manifest(deviceId) { return this.manifests.get(deviceId) || null; }
  videoInputs() { return this.devices.filter((d) => d.kind === 'videoinput'); }
  audioInputs() { return this.devices.filter((d) => d.kind === 'audioinput'); }
}

function addUnique(arr, v) { if (!arr.includes(v)) arr.push(v); }

export function guessModality(label = '') {
  const l = String(label).toLowerCase();
  if (/thermal|flir|seek|lepton|boson|radiometric/.test(l)) return { guess: 'thermal (by name only)', verified: false, note: 'Name suggests a thermal device. The browser cannot confirm radiometric data; treat the image as a visualization unless verified with the vendor tool.' };
  if (/\bir\b|infrared|night/.test(l)) return { guess: 'infrared (by name only)', verified: false, note: 'Name suggests infrared sensitivity. Not verified.' };
  if (/depth|realsense|kinect|zed/.test(l)) return { guess: 'depth (by name only)', verified: false, note: 'Depth stream is not exposed through the browser camera API; only its colour stream is available.' };
  if (/obs|virtual|snap|manycam|loopback/.test(l)) return { guess: 'virtual (software source)', verified: false, note: 'A software-provided video source, not a physical sensor.' };
  return { guess: 'visible_light', verified: true, note: 'Standard colour video (UVC-class or built-in).' };
}

export function summarizeCaps(c = {}) {
  const r = (k) => (c[k] && typeof c[k] === 'object' ? `${c[k].min ?? '?'}–${c[k].max ?? '?'}` : c[k] ?? null);
  return { width: r('width'), height: r('height'), frameRate: r('frameRate'), facingMode: c.facingMode || null, controls: Object.keys(c).filter((k) => !['deviceId', 'groupId', 'width', 'height', 'frameRate', 'aspectRatio', 'facingMode', 'resizeMode'].includes(k)) };
}
