// WebGL renderer: the whole correction and rendering pipeline runs in one fragment shader so that
// every model acts on a shared scene representation instead of stacking effects.

const VS = `
attribute vec2 a_pos; varying vec2 v_uv;
void main(){ v_uv = vec2(a_pos.x*0.5+0.5, 0.5-a_pos.y*0.5); gl_Position = vec4(a_pos,0.0,1.0); }`;

const FS = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_texel;
uniform float u_mirror, u_k1, u_zoom, u_faceR, u_persp, u_exposure, u_contrast, u_saturation, u_warmth;
uniform float u_sharpen, u_vignette, u_grain, u_time, u_filmic, u_skin, u_aspect;
uniform float u_highlightSoft, u_shadowLift, u_bgDesat, u_skinProtect;
uniform vec2 u_face; uniform vec3 u_wb, u_shadowTint;

vec3 toLin(vec3 c){ return pow(max(c,0.0), vec3(2.2)); }
vec3 toSrgb(vec3 c){ return pow(max(c,0.0), vec3(1.0/2.2)); }
float luma(vec3 c){ return dot(c, vec3(0.2126,0.7152,0.0722)); }
vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0.0,1.0); }
vec3 rolloff(vec3 x){ // gentle highlight shoulder: linear to 0.8, then exponential approach to 1
  vec3 lo = min(x, 0.8); vec3 hi = max(x-0.8, 0.0);
  return lo + 0.2*(1.0-exp(-hi/0.2));
}
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)))*43758.5453); }
vec3 sampleLin(vec2 p){ return toLin(texture2D(u_tex, clamp(p, 0.0, 1.0)).rgb); }

void main(){
  vec2 uv = v_uv;
  if (u_mirror > 0.5) uv.x = 1.0 - uv.x;

  // --- geometry: framing zoom, radial lens distortion correction (Brown-Conrady), face-local perspective
  vec2 c = (uv - 0.5); c.x *= u_aspect; c *= u_zoom;
  vec2 cd = c * (1.0 + u_k1 * dot(c,c));
  vec2 fc = (u_face - 0.5); fc.x *= u_aspect;
  vec2 d = cd - fc; float fr = length(d);
  float w = (u_faceR > 0.0) ? 1.0 - smoothstep(0.0, u_faceR, fr) : 0.0;
  cd += d * u_persp * w;
  cd.x /= u_aspect; uv = cd + 0.5;

  // --- texture: unsharp mask (sharpen) or wide blur blend (soften), in linear light
  vec3 c0 = sampleLin(uv);
  float rad = u_sharpen >= 0.0 ? 1.0 : 2.5;
  vec2 tx = u_texel * rad;
  vec3 n = sampleLin(uv+vec2(tx.x,0.0)) + sampleLin(uv-vec2(tx.x,0.0)) + sampleLin(uv+vec2(0.0,tx.y)) + sampleLin(uv-vec2(0.0,tx.y));
  vec3 blur = (c0*4.0 + n) / 8.0;
  vec3 col = (u_sharpen >= 0.0) ? c0 + (c0 - blur) * u_sharpen : mix(c0, blur, -u_sharpen);

  // --- colour: white balance, exposure, warmth, highlight softening, tone
  col *= u_wb * u_exposure;
  col.r *= 1.0 + u_warmth; col.b *= 1.0 - u_warmth;
  col = col / (1.0 + u_highlightSoft * max(col - 0.7, 0.0));
  vec3 toned = mix(rolloff(col), aces(col), u_filmic);
  vec3 s = toSrgb(toned);

  // --- skin weight (YCbCr box) used to protect skin from stylistic shifts
  float Y = dot(s, vec3(0.299,0.587,0.114));
  float Cb = 0.5 - 0.168736*s.r - 0.331264*s.g + 0.5*s.b;
  float Cr = 0.5 + 0.5*s.r - 0.418688*s.g - 0.081312*s.b;
  float skinW = smoothstep(0.28,0.33,Cb) * (1.0-smoothstep(0.47,0.52,Cb)) * smoothstep(0.50,0.55,Cr) * (1.0-smoothstep(0.66,0.70,Cr));
  float protect = skinW * u_skinProtect;

  // --- perception: contrast and saturation around mid grey
  s = (s - 0.5) * u_contrast + 0.5;
  float l = luma(s);
  s = mix(vec3(l), s, u_saturation);

  // --- skin calibration: pull skin chroma gently toward a natural reference, never the structure
  float Cb2 = 0.5 - 0.168736*s.r - 0.331264*s.g + 0.5*s.b;
  float Cr2 = 0.5 + 0.5*s.r - 0.418688*s.g - 0.081312*s.b;
  float Y2 = dot(s, vec3(0.299,0.587,0.114));
  float k = u_skin * skinW * 0.35;
  Cb2 = mix(Cb2, 0.42, k); Cr2 = mix(Cr2, 0.60, k);
  vec3 skinFixed = vec3(Y2 + 1.402*(Cr2-0.5), Y2 - 0.344136*(Cb2-0.5) - 0.714136*(Cr2-0.5), Y2 + 1.772*(Cb2-0.5));
  s = mix(s, skinFixed, skinW);

  // --- adaptive aura: background desaturation, shadow tint, shadow lift (skin protected)
  float bgW = 1.0 - protect;
  s = mix(s, vec3(luma(s)), u_bgDesat * bgW);
  s += u_shadowTint * (1.0 - smoothstep(0.0, 0.45, luma(s))) * bgW;
  s = s * (1.0 - u_shadowLift) + u_shadowLift;

  // --- optics: vignette; film: grain
  vec2 vc = (v_uv - 0.5); vc.x *= u_aspect;
  s *= 1.0 - u_vignette * smoothstep(0.45, 1.3, length(vc));
  s += (hash(gl_FragCoord.xy + fract(u_time)) - 0.5) * u_grain;
  gl_FragColor = vec4(clamp(s, 0.0, 1.0), 1.0);
}`;

const UNIFORMS = ['u_tex', 'u_texel', 'u_mirror', 'u_k1', 'u_zoom', 'u_faceR', 'u_persp', 'u_exposure', 'u_contrast', 'u_saturation', 'u_warmth',
  'u_sharpen', 'u_vignette', 'u_grain', 'u_time', 'u_filmic', 'u_skin', 'u_aspect', 'u_highlightSoft', 'u_shadowLift', 'u_bgDesat', 'u_skinProtect', 'u_face', 'u_wb', 'u_shadowTint'];

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const opts = { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false, powerPreference: 'high-performance' };
    const gl = canvas.getContext('webgl2', opts) || canvas.getContext('webgl', opts);
    if (!gl) throw new Error('WebGL is not available in this browser.');
    this.gl = gl;
    const prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, FS]]) {
      const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('Shader error: ' + gl.getShaderInfoLog(sh));
      gl.attachShader(prog, sh);
    }
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('Program link error: ' + gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    this.prog = prog;
    this.u = Object.fromEntries(UNIFORMS.map((n) => [n, gl.getUniformLocation(prog, n)]));
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a_pos'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.uniform1i(this.u.u_tex, 0);
    this.w = 0; this.h = 0;
  }

  resize(w, h) {
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h; this.canvas.width = w; this.canvas.height = h; this.gl.viewport(0, 0, w, h);
  }

  /** Upload the source frame and render it with the given parameters. */
  draw(source, p, time = 0) {
    const gl = this.gl, u = this.u;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source); } catch { return; }
    gl.uniform2f(u.u_texel, 1 / this.w, 1 / this.h);
    gl.uniform1f(u.u_mirror, p.mirror); gl.uniform1f(u.u_k1, p.k1); gl.uniform1f(u.u_zoom, p.zoom);
    gl.uniform2f(u.u_face, p.face[0], p.face[1]); gl.uniform1f(u.u_faceR, p.faceR); gl.uniform1f(u.u_persp, p.persp);
    gl.uniform3f(u.u_wb, p.wb[0], p.wb[1], p.wb[2]); gl.uniform1f(u.u_exposure, p.exposure);
    gl.uniform1f(u.u_contrast, p.contrast); gl.uniform1f(u.u_saturation, p.saturation); gl.uniform1f(u.u_warmth, p.warmth);
    gl.uniform1f(u.u_sharpen, p.sharpen); gl.uniform1f(u.u_vignette, p.vignette); gl.uniform1f(u.u_grain, p.grain);
    gl.uniform1f(u.u_time, time); gl.uniform1f(u.u_filmic, p.filmic); gl.uniform1f(u.u_skin, p.skin); gl.uniform1f(u.u_aspect, p.aspect);
    gl.uniform1f(u.u_highlightSoft, p.highlightSoft); gl.uniform1f(u.u_shadowLift, p.shadowLift);
    gl.uniform1f(u.u_bgDesat, p.bgDesat); gl.uniform1f(u.u_skinProtect, p.skinProtect);
    gl.uniform3f(u.u_shadowTint, p.shadowTint[0], p.shadowTint[1], p.shadowTint[2]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

/** Smoothly move rendering parameters toward a target: temporal consistency for video (principle 78). */
export function smoothParams(cur, target, a) {
  if (!cur) return { ...target, face: target.face.slice(), wb: target.wb.slice(), shadowTint: target.shadowTint.slice() };
  for (const k in target) {
    const t = target[k];
    if (typeof t === 'number') cur[k] = k === 'mirror' || k === 'skinProtect' ? t : cur[k] + (t - cur[k]) * a;
    else if (Array.isArray(t)) { for (let i = 0; i < t.length; i++) cur[k][i] += (t[i] - cur[k][i]) * a; }
  }
  return cur;
}
