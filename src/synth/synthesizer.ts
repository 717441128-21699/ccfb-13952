/**
 * 红外序列合成引擎（纯 TS，无 DOM 依赖，可在 Node 测试中运行）
 *
 * 渲染流程（每帧）：
 *  1. 由吊运运动学生成位姿（摆振/自转/漂移/尺度呼吸）
 *  2. 对规范表面 (phi,h) 稠密采样，正向投影到屏幕，z-buffer 去遮挡
 *  3. 发射率场 + 烟尘透过率场经辐射模型生成相机亮度温度
 *  4. 天车钩子（高温盘）、硬遮挡半屏、背景与传感器噪声叠加
 * 真值随帧旁路输出，供测试校验（管线本身不读取）。
 */
import type { FrameRecord, FrameTruth, LadlePose, SequenceHeader } from '../core/types';
import { MAP_H, MAP_W } from '../core/types';
import { Rng } from '../core/rng';
import {
  projectSurface,
  surfaceToLocal,
  localToScreen,
} from '../core/geometry';
import { buildThermalField, fieldAt, type ThermalField } from '../core/thermalField';
import { observedTempK } from '../core/radiation';
import { scenarioHotspots, type ScenarioConfig } from './scenario';

const TWO_PI = Math.PI * 2;

export interface BuiltScenario {
  cfg: ScenarioConfig;
  header: SequenceHeader;
  field: ThermalField;
  frameCount: number;
}

export function buildScenario(cfg: ScenarioConfig): BuiltScenario {
  const frameCount = Math.round(cfg.durationSec * cfg.fps);
  const header: SequenceHeader = {
    magic: 'LIRS1',
    seqId: cfg.seqId,
    ladleId: cfg.ladleId,
    campaignNo: cfg.campaignNo,
    ladleAge: cfg.ladleAge,
    width: cfg.width,
    height: cfg.height,
    fps: cfg.fps,
    frameCount,
    emissivityNominal: cfg.emissivityNominal,
    ambientK: cfg.ambientK,
    geometry: cfg.geometry,
    cameraFovYDeg: 30,
    scenario: cfg.scenario,
    createdAt: new Date(0).toISOString(),
  };
  const field = buildThermalField(cfg.geometry, {
    ladleAge: cfg.ladleAge,
    baseTempK: cfg.baseTempK,
    hotspots: scenarioHotspots(cfg),
    seed: cfg.seed,
  });
  return { cfg, header, field, frameCount };
}

/** 由运动学计算第 index 帧位姿 */
export function poseAt(cfg: ScenarioConfig, index: number): LadlePose {
  const t = index / cfg.fps;
  const m = cfg.motion;
  const baseScale = (cfg.height * 0.42) / cfg.geometry.height;
  const swing = Math.sin(TWO_PI * m.swingFreqHz * t) * m.swingPx;
  const bob = Math.sin(TWO_PI * m.bobFreqHz * t) * m.bobPx;
  return {
    cx: cfg.width / 2 + m.driftPxPerSec * t + swing,
    cy: cfg.height / 2 + bob,
    scale: baseScale * (1 + m.scaleBreath * Math.sin(TWO_PI * m.swingFreqHz * t + 1.3)),
    tiltX: (m.tiltXDeg * Math.PI) / 180,
    tiltZ: (m.swingAngleDeg * Math.PI / 180) * Math.cos(TWO_PI * m.swingFreqHz * t),
    yaw: ((m.yawRateDegPerSec * Math.PI) / 180) * t,
  };
}

function gauss2(dx: number, dy: number, sigma: number): number {
  return Math.exp(-0.5 * (dx * dx + dy * dy) / (sigma * sigma));
}

/** 计算逐像素烟尘透过率（先低分辨率网格再双线性放大） */
function smokeTauField(cfg: ScenarioConfig, t: number): Float32Array {
  const W = cfg.width;
  const H = cfg.height;
  const gw = Math.max(8, Math.round(W / 8));
  const gh = Math.max(8, Math.round(H / 8));
  const grid = new Float32Array(gw * gh);
  const u = cfg.durationSec > 0 ? Math.min(1, t / cfg.durationSec) : 0;
  for (const s of cfg.smoke) {
    if (t < s.startSec || t > s.endSec) continue;
    const cx = (s.x0 + (s.x1 - s.x0) * u) * W;
    const cy = (s.y0 + (s.y1 - s.y0) * u) * H;
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        const px = ((gx + 0.5) / gw) * W;
        const py = ((gy + 0.5) / gh) * H;
        const g = gauss2(px - cx, py - cy, s.sigmaPx);
        const tau = 1 - (1 - s.tauMin) * g;
        const idx = gy * gw + gx;
        grid[idx] = grid[idx] === 0 ? tau : Math.min(grid[idx], tau);
      }
    }
  }
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const fx = (x / W) * gw - 0.5;
      const fy = (y / H) * gh - 0.5;
      const x0 = Math.max(0, Math.min(gw - 1, Math.floor(fx)));
      const y0 = Math.max(0, Math.min(gh - 1, Math.floor(fy)));
      const x1 = Math.min(gw - 1, x0 + 1);
      const y1 = Math.min(gh - 1, y0 + 1);
      const tx = fx - Math.floor(fx);
      const ty = fy - Math.floor(fy);
      const a = grid[y0 * gw + x0] * (1 - tx) + grid[y0 * gw + x1] * tx;
      const b = grid[y1 * gw + x0] * (1 - tx) + grid[y1 * gw + x1] * tx;
      const v = a * (1 - ty) + b * ty;
      // 无烟团时网格为 0，视作透过率 1
      out[y * W + x] = v === 0 ? 1 : v;
    }
  }
  return out;
}

function activeOcclusion(cfg: ScenarioConfig, t: number): 'left' | 'right' | null {
  for (const o of cfg.occlusions) {
    if (t >= o.startSec && t <= o.endSec) return o.side;
  }
  return null;
}

/** 生成单帧温度矩阵与真值 */
export function renderFrame(built: BuiltScenario, index: number): FrameRecord {
  const { cfg, field } = built;
  const W = cfg.width;
  const H = cfg.height;
  const t = index / cfg.fps;
  const pose = poseAt(cfg, index);
  const rng = new Rng((cfg.seed * 1_000_003 + index * 97) >>> 0);

  const tempK = new Float32Array(W * H);
  const depth = new Float32Array(W * H).fill(1e9);
  const tau = smokeTauField(cfg, t);

  // 背景：厂房环境，带轻微梯度
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      tempK[y * W + x] = cfg.ambientK + 12 * (y / H) + rng.gaussian(0.6);
    }
  }

  // 包壁正向投影（z-buffer）
  const g = cfg.geometry;
  const nPhi = MAP_W * 2;
  const nH = MAP_H * 2;
  for (let ih = 0; ih < nH; ih++) {
    const hNorm = (ih + 0.5) / nH;
    const h = hNorm * g.height;
    for (let ip = 0; ip < nPhi; ip++) {
      const phiLocal = (ip / nPhi) * TWO_PI;
      // 几何投影用零 yaw：屏幕位置只由摆振/俯仰决定，与自转无关（回转体轮廓不变）。
      // 材质纹理随刚体自转，本体角 = 局部角 + yaw，几何与纹理分离，yaw 信息保留在图像中。
      const geomPose: LadlePose = { ...pose, yaw: 0 };
      const sp = projectSurface({ phi: phiLocal, h }, g, geomPose);
      if (sp.depth <= 0) continue;
      const x = Math.round(sp.x);
      const y = Math.round(sp.y);
      if (x < 0 || x >= W || y < 0 || y >= H) continue;
      const pi = y * W + x;
      if (sp.depth >= depth[pi]) continue;
      depth[pi] = sp.depth;

      // 本体材质角随刚体自转：phiBody = phiLocal + yaw
      const phiBody = (phiLocal + pose.yaw) % TWO_PI;
      const hN = h / g.height;
      const wallT = fieldAt(phiBody, hN, field.trueTempK);
      const eps = fieldAt(phiBody, hN, field.emissivity);
      const observed = observedTempK(wallT, {
        emissivity: eps,
        transmittance: tau[pi],
        ambientK: cfg.ambientK,
        smokeTempK: cfg.smokeTempK,
      });
      tempK[pi] = observed + rng.gaussian(cfg.sensorNoiseSigmaK);
    }
  }

  // 硬遮挡半屏：用冷背景覆盖（模拟设备挡住）
  const occ = activeOcclusion(cfg, t);
  if (occ) {
    const half = Math.floor(W / 2);
    const [x0, x1] = occ === 'left' ? [0, half] : [W - half, W];
    for (let y = 0; y < H; y++) {
      for (let x = x0; x < x1; x++) {
        tempK[y * W + x] = cfg.ambientK - 15 + rng.gaussian(0.5);
      }
    }
  }

  // 天车钩子：包口上方高温盘，在遮挡层之后绘制（钩子本身不被设备遮没时可见）
  let hookTruth: FrameTruth['hook'] = null;
  const hk = cfg.hook;
  if (hk && t >= hk.startSec && t <= hk.endSec) {
    const hx = pose.cx + hk.offsetX * pose.scale;
    const mouthLocal = surfaceToLocal({ phi: 0, h: g.height }, g);
    const mouth = localToScreen(mouthLocal, pose);
    // 屏幕 y 向下为正：包口上方应减去世界偏移对应的像素
    const hy = mouth.y - hk.offsetY * pose.scale;
    const r = hk.radiusPx;
    for (let y = Math.max(0, Math.floor(hy - r)); y < Math.min(H, Math.ceil(hy + r)); y++) {
      for (let x = Math.max(0, Math.floor(hx - r)); x < Math.min(W, Math.ceil(hx + r)); x++) {
        const d2 = (x - hx) ** 2 + (y - hy) ** 2;
        if (d2 > r * r) continue;
        const edge = 1 - Math.sqrt(d2) / r;
        tempK[y * W + x] = hk.tempK * (0.85 + 0.15 * edge) + rng.gaussian(2);
      }
    }
    hookTruth = { x: hx, y: hy, r, tempK: hk.tempK };
  }

  const truth: FrameTruth = {
    pose,
    occludedSide: occ,
    smokeTauMin: tau.reduce((m, v) => Math.min(m, v), 1),
    hook: hookTruth,
  };
  return { index, tSec: t, tempK, truth };
}

/** 惰性序列：按需生成帧（10 分钟序列也不会一次性占满内存） */
export class SyntheticSequence {
  readonly built: BuiltScenario;

  constructor(public cfg: ScenarioConfig) {
    this.built = buildScenario(cfg);
  }

  get header(): SequenceHeader {
    return this.built.header;
  }

  get frameCount(): number {
    return this.built.frameCount;
  }

  frame(index: number): FrameRecord {
    if (index < 0 || index >= this.frameCount) throw new RangeError(`frame ${index} 越界`);
    return renderFrame(this.built, index);
  }

  *frames(): Generator<FrameRecord> {
    for (let i = 0; i < this.frameCount; i++) yield this.frame(i);
  }
}
