/**
 * WebGL2 浮点计算管线
 *
 * 职责划分（重活在 GPU，轻量逻辑在 CPU 复用同一套实现）：
 *   GPU：逐像素分割、透过率场估计、包壁展开+辐射反演（360×96 查找表渲染）
 *   CPU：连通域/钩子判定、位姿拟合、yaw 环形相关、融合、热点与报警
 * 全部走 R32F/RGBA32F 浮点纹理与 FBO，readPixels 直接拿 Float32 结果。
 */
import type { LadleGeometry, LadlePose, PipelineConfig } from '../core/types';
import { MAP_H, MAP_W } from '../core/types';

const VERT = `#version 300 es
layout(location=0) in vec2 a_pos;
out vec2 v_uv;
void main(){
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

/** 1) 分割：R 通道输出 0/1 掩码；同时输出透过率场到 G 通道 */
const SEG_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_temp;
uniform float u_segK;
uniform vec2 u_texSize;
out vec4 outColor;
void main(){
  float t = texture(u_temp, v_uv).r;
  float m = t >= u_segK ? 1.0 : 0.0;
  outColor = vec4(m, 1.0, 0.0, 1.0);
}`;

/**
 * 2) 透过率场：按高度带干净参照（CPU 计算后传入 1×12 浮点纹理），
 * 辐射域反演 τ。无烟像素 τ=1。
 */
const TAU_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_temp;
uniform sampler2D u_mask;
uniform sampler2D u_refs;   // 1x12 R32F，逐高度带参照温度
uniform float u_eps;
uniform float u_ambK;
uniform float u_smkK;
out vec4 outColor;
float m4(float t){ return t*t*t*t; }
void main(){
  float mask = texture(u_mask, v_uv).r;
  float t = texture(u_temp, v_uv).r;
  float band = min(11.0, floor((1.0 - v_uv.y) * 12.0));
  float refT = texture(u_refs, vec2((band + 0.5) / 12.0, 0.5)).r;
  float tau = 1.0;
  if (mask > 0.5 && refT > 1.0 && t < refT - 8.0) {
    float a = u_eps * m4(refT) + (1.0 - u_eps) * m4(u_ambK) - m4(u_smkK);
    if (abs(a) > 1.0) tau = clamp((m4(t) - m4(u_smkK)) / a, 0.0, 1.0);
  }
  outColor = vec4(tau, 0.0, 0.0, 1.0);
}`;

/**
 * 3) 展开查找表渲染：对输出图每个 (phi,h) 像素逆投影回屏幕采样，
 * 命中掩码且 depth>0 时做发射率/烟尘辐射反演；权重写入 G 通道。
 */
const UNWRAP_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_temp;
uniform sampler2D u_mask;
uniform sampler2D u_tau;
uniform vec2 u_frameSize;
uniform vec3 u_pose;      // cx, cy, scale
uniform vec2 u_tilt;      // tiltX, tiltZ
uniform float u_yaw;
uniform vec3 u_geom;      // rTop, rBottom, height
uniform float u_eps;
uniform float u_ambK;
uniform float u_smkK;
out vec4 outColor;

vec3 rotY(vec3 v, float a){ float c=cos(a),s=sin(a); return vec3(c*v.x+s*v.z, v.y, -s*v.x+c*v.z); }
vec3 rotX(vec3 v, float a){ float c=cos(a),s=sin(a); return vec3(v.x, c*v.y-s*v.z, s*v.y+c*v.z); }
vec3 rotZ(vec3 v, float a){ float c=cos(a),s=sin(a); return vec3(c*v.x-s*v.y, s*v.x+c*v.y, v.z); }
float m4(float t){ return t*t*t*t; }

void main(){
  // v_uv.y=0 在图底 -> h=0；列 -> phi
  float phi = v_uv.x * 6.28318530718;
  float h = v_uv.y * u_geom.z;
  float r = u_geom.y + (u_geom.x - u_geom.y) * (h / u_geom.z);
  vec3 local = vec3(r * sin(phi), h - u_geom.z * 0.5, r * cos(phi));
  vec3 p = rotY(local, u_yaw);
  p = rotX(p, u_tilt.x);
  p = rotZ(p, u_tilt.y);
  vec2 screen = vec2(u_pose.x + p.x * u_pose.z, u_pose.y - p.y * u_pose.z);
  vec2 uv = vec2(screen.x / u_frameSize.x, 1.0 - screen.y / u_frameSize.y);

  float weight = 0.0;
  float corrected = u_ambK;
  if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0 && p.z > 0.0) {
    float mask = texture(u_mask, uv).r;
    if (mask > 0.5) {
      float observed = texture(u_temp, uv).r;
      float tau = texture(u_tau, uv).r;
      float e = max(0.001, u_eps);
      float tt = max(0.001, tau);
      float mw = (m4(observed) - tt*(1.0-e)*m4(u_ambK) - (1.0-tt)*m4(u_smkK)) / (tt*e);
      corrected = clamp(pow(max(0.0, mw), 0.25), 250.0, 3500.0);
      weight = 0.25 + 0.75 * tau;
    }
  }
  outColor = vec4(corrected, weight, 0.0, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('无法创建 shader');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('shader 编译失败: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

function makeProgram(gl: WebGL2RenderingContext, frag: string): WebGLProgram {
  const p = gl.createProgram();
  if (!p) throw new Error('无法创建 program');
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('program 链接失败: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
}

export class GpuEngine {
  readonly gl: WebGL2RenderingContext;
  private vao: WebGLVertexArrayObject;
  private segProg: WebGLProgram;
  private tauProg: WebGLProgram;
  private unwrapProg: WebGLProgram;
  private frameTex: WebGLTexture;
  private refsTex: WebGLTexture;
  private segTarget: Target;
  private tauTarget: Target;
  private mapTarget: Target;
  private readonly frameW: number;
  private readonly frameH: number;

  constructor(canvas: OffscreenCanvas | HTMLCanvasElement, frameW: number, frameH: number) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      preserveDrawingBuffer: false,
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('当前环境不支持 WebGL2');
    const ext = gl.getExtension('EXT_color_buffer_float');
    if (!ext) throw new Error('不支持浮点颜色缓冲 EXT_color_buffer_float');
    this.gl = gl;
    this.frameW = frameW;
    this.frameH = frameH;

    const quad = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    this.vao = gl.createVertexArray() as WebGLVertexArrayObject;
    gl.bindVertexArray(this.vao);
    const vbo = gl.createBuffer() as WebGLBuffer;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.segProg = makeProgram(gl, SEG_FRAG);
    this.tauProg = makeProgram(gl, TAU_FRAG);
    this.unwrapProg = makeProgram(gl, UNWRAP_FRAG);

    this.frameTex = this.uploadTemp(new Float32Array(frameW * frameH));
    this.refsTex = this.makeRefsTexture(new Float32Array(12));
    this.segTarget = this.makeTarget(frameW, frameH, gl.RGBA32F);
    this.tauTarget = this.makeTarget(frameW, frameH, gl.RGBA32F);
    this.mapTarget = this.makeTarget(MAP_W, MAP_H, gl.RGBA32F);
  }

  private makeTarget(w: number, h: number, internal: number): Target {
    const gl = this.gl;
    const tex = gl.createTexture() as WebGLTexture;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer() as WebGLFramebuffer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('浮点 FBO 不完整');
    }
    return { tex, fbo, w, h };
  }

  private uploadTemp(data: Float32Array): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture() as WebGLTexture;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, this.frameW, this.frameH, 0, gl.RED, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private makeRefsTexture(data: Float32Array): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture() as WebGLTexture;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 12, 1, 0, gl.RED, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private bindTex(unit: number, tex: WebGLTexture): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  private drawTo(target: Target): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.w, target.h);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /** 一帧 GPU 处理：返回掩码、透过率场与展开图（温度+权重） */
  processFrame(
    tempK: Float32Array,
    pose: LadlePose,
    geom: LadleGeometry,
    cfg: PipelineConfig,
    cleanRefs: Float32Array,
  ): { mask: Uint8Array; tau: Float32Array; mapTemp: Float32Array; mapWeight: Float32Array } {
    const gl = this.gl;
    // 更新输入纹理
    gl.bindTexture(gl.TEXTURE_2D, this.frameTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.frameW, this.frameH, gl.RED, gl.FLOAT, tempK);

    // 1) 分割
    gl.useProgram(this.segProg);
    this.bindTex(0, this.frameTex);
    gl.uniform1i(gl.getUniformLocation(this.segProg, 'u_temp'), 0);
    gl.uniform1f(gl.getUniformLocation(this.segProg, 'u_segK'), cfg.segmentThresholdK);
    gl.uniform2f(gl.getUniformLocation(this.segProg, 'u_texSize'), this.frameW, this.frameH);
    this.drawTo(this.segTarget);

    // 2) 透过率
    gl.bindTexture(gl.TEXTURE_2D, this.refsTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 12, 1, gl.RED, gl.FLOAT, cleanRefs);
    gl.useProgram(this.tauProg);
    this.bindTex(0, this.frameTex);
    this.bindTex(1, this.segTarget.tex);
    this.bindTex(2, this.refsTex);
    gl.uniform1i(gl.getUniformLocation(this.tauProg, 'u_temp'), 0);
    gl.uniform1i(gl.getUniformLocation(this.tauProg, 'u_mask'), 1);
    gl.uniform1i(gl.getUniformLocation(this.tauProg, 'u_refs'), 2);
    gl.uniform1f(gl.getUniformLocation(this.tauProg, 'u_eps'), cfg.emissivityNominal);
    gl.uniform1f(gl.getUniformLocation(this.tauProg, 'u_ambK'), cfg.ambientK);
    gl.uniform1f(gl.getUniformLocation(this.tauProg, 'u_smkK'), cfg.smokeTempK);
    this.drawTo(this.tauTarget);

    // 3) 展开
    gl.useProgram(this.unwrapProg);
    this.bindTex(0, this.frameTex);
    this.bindTex(1, this.segTarget.tex);
    this.bindTex(2, this.tauTarget.tex);
    const U = this.unwrapProg;
    gl.uniform1i(gl.getUniformLocation(U, 'u_temp'), 0);
    gl.uniform1i(gl.getUniformLocation(U, 'u_mask'), 1);
    gl.uniform1i(gl.getUniformLocation(U, 'u_tau'), 2);
    gl.uniform2f(gl.getUniformLocation(U, 'u_frameSize'), this.frameW, this.frameH);
    gl.uniform3f(gl.getUniformLocation(U, 'u_pose'), pose.cx, pose.cy, pose.scale);
    gl.uniform2f(gl.getUniformLocation(U, 'u_tilt'), pose.tiltX, pose.tiltZ);
    gl.uniform1f(gl.getUniformLocation(U, 'u_yaw'), pose.yaw);
    gl.uniform3f(gl.getUniformLocation(U, 'u_geom'), geom.rTop, geom.rBottom, geom.height);
    gl.uniform1f(gl.getUniformLocation(U, 'u_eps'), cfg.emissivityNominal);
    gl.uniform1f(gl.getUniformLocation(U, 'u_ambK'), cfg.ambientK);
    gl.uniform1f(gl.getUniformLocation(U, 'u_smkK'), cfg.smokeTempK);
    this.drawTo(this.mapTarget);

    return {
      mask: this.readMask(),
      tau: this.readChannel(this.tauTarget, 0),
      mapTemp: this.readChannel(this.mapTarget, 0),
      mapWeight: this.readChannel(this.mapTarget, 1),
    };
  }

  private readMask(): Uint8Array {
    const gl = this.gl;
    const px = new Float32Array(this.frameW * this.frameH * 4);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(0, 0, this.frameW, this.frameH, gl.RGBA, gl.FLOAT, px);
    const out = new Uint8Array(this.frameW * this.frameH);
    // WebGL 像素原点在左下，翻转回行优先（左上原点）
    for (let y = 0; y < this.frameH; y++) {
      for (let x = 0; x < this.frameW; x++) {
        const src = ((this.frameH - 1 - y) * this.frameW + x) * 4;
        out[y * this.frameW + x] = px[src] > 0.5 ? 1 : 0;
      }
    }
    return out;
  }

  private readChannel(target: Target, channel: number): Float32Array {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    const px = new Float32Array(target.w * target.h * 4);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(0, 0, target.w, target.h, gl.RGBA, gl.FLOAT, px);
    const out = new Float32Array(target.w * target.h);
    for (let y = 0; y < target.h; y++) {
      for (let x = 0; x < target.w; x++) {
        const src = ((target.h - 1 - y) * target.w + x) * 4 + channel;
        out[y * target.w + x] = px[src];
      }
    }
    return out;
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteTexture(this.frameTex);
    gl.deleteTexture(this.refsTex);
    gl.deleteTexture(this.segTarget.tex);
    gl.deleteTexture(this.tauTarget.tex);
    gl.deleteTexture(this.mapTarget.tex);
    gl.deleteFramebuffer(this.segTarget.fbo);
    gl.deleteFramebuffer(this.tauTarget.fbo);
    gl.deleteFramebuffer(this.mapTarget.fbo);
    gl.deleteProgram(this.segProg);
    gl.deleteProgram(this.tauProg);
    gl.deleteProgram(this.unwrapProg);
    gl.deleteVertexArray(this.vao);
  }
}
