/**
 * 包壁展开：帧温度矩阵 -> 规范平面温度图
 *
 * 对展开图每个 (phi,h) 单元：
 *  1. 用当前位姿逆投影到屏幕，落在包壁掩码外则权重 0（硬遮挡/出界）
 *  2. 估计该像素烟尘透过率 τ（与同高度带干净参照在辐射域对比）
 *  3. 按耐材发射率与 τ 做辐射域反演，得到真实壁温
 * CPU 实现为算法基准；GPU 路径（unwarpGL.ts）复用同一公式。
 */
import type { LadleGeometry, LadlePose, PipelineConfig, UnwrapMap } from '../core/types';
import { MAP_H, MAP_W } from '../core/types';
import { canonicalSurfaceAt, projectSurface } from '../core/geometry';
import { correctTempK, estimateTransmittance, m4 } from '../core/radiation';

export interface UnwrapInput {
  tempK: Float32Array;
  mask: Uint8Array;
  W: number;
  H: number;
  pose: LadlePose;
  g: LadleGeometry;
  cfg: PipelineConfig;
  /**
   * 归一化投影位姿（可选）。提供时展开几何用它而非 pose 的平移/尺度，
   * 用于消除吊运摆振/尺度呼吸对展开图的扰动，仅保留 tilt 与 yaw 自由度。
   */
  normalized?: Partial<LadlePose>;
  /** 预计算的全帧透过率场，复用以避免多次展开时重复估计 */
  tauField?: Float32Array;
  /**
   * 预校正的全帧温度（已做发射率/烟尘反演）。提供时展开只做几何重采样，
   * 跳过逐像素辐射反演，供第二次（不同 yaw 的）展开复用。
   */
  correctedFrame?: Float32Array;
}

/** 逐高度带的"干净参照温度"：取带内掩码像素的最高温（最接近无烟壁面），O(n) 免排序 */
export function cleanReferenceByBand(
  tempK: Float32Array,
  mask: Uint8Array,
  tauHint: Float32Array | null,
  W: number,
  H: number,
  bands: number,
): Float32Array {
  const refs = new Float32Array(bands);
  const counts = new Uint32Array(bands);
  for (let y = 0; y < H; y++) {
    const b = Math.min(bands - 1, Math.floor((y / H) * bands));
    const rowBase = y * W;
    for (let x = 0; x < W; x++) {
      const i = rowBase + x;
      if (!mask[i]) continue;
      if (tauHint && tauHint[i] < 0.85) continue;
      if (tempK[i] > refs[b]) refs[b] = tempK[i];
      counts[b]++;
    }
  }
  for (let b = 0; b < bands; b++) if (counts[b] === 0) refs[b] = 0;
  return refs;
}

/**
 * 估计全帧透过率场。没有独立 τ 传感器时，用干净参照反演：
 * 同高度带内，观测辐射低于参照的像素按烟尘模型折算 τ；干净像素 τ=1。
 */
export function estimateTauField(inp: UnwrapInput): Float32Array {
  const { tempK, mask, W, H, cfg } = inp;
  const bands = 12;
  const refs = cleanReferenceByBand(tempK, mask, null, W, H, bands);
  const tau = new Float32Array(W * H).fill(1);  for (let y = 0; y < H; y++) {
    const band = Math.min(bands - 1, Math.floor((y / H) * bands));
    const ref = refs[band];
    if (ref <= 0) continue;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!mask[i]) {
        tau[i] = 1;
        continue;
      }
      if (tempK[i] >= ref - 8) {
        tau[i] = 1;
        continue;
      }
      tau[i] = estimateTransmittance(
        tempK[i],
        ref,
        cfg.emissivityNominal,
        cfg.ambientK,
        cfg.smokeTempK,
      );
    }
  }
  return tau;
}

export function unwrapFrame(inp: UnwrapInput): UnwrapMap {
  const { tempK, mask, W, H, pose, g, cfg, normalized } = inp;
  const tauField = inp.tauField ?? estimateTauField(inp);
  // 归一化位姿：平移/尺度固定到帧中心的标准尺度，tilt/tiltZ 沿用实测，yaw 由调用方指定
  const projPose: LadlePose = normalized
    ? { ...pose, ...normalized }
    : pose;
  const out = new Float32Array(MAP_W * MAP_H);
  const weight = new Float32Array(MAP_W * MAP_H);

  for (let row = 0; row < MAP_H; row++) {
    for (let col = 0; col < MAP_W; col++) {
      const sp = canonicalSurfaceAt(col, row, g);
      const pr = projectSurface(sp, g, projPose);
      const x = Math.round(pr.x);
      const y = Math.round(pr.y);
      const idx = row * MAP_W + col;
      if (x < 0 || x >= W || y < 0 || y >= H || pr.depth <= 0) {
        out[idx] = cfg.ambientK;
        weight[idx] = 0;
        continue;
      }
      const pi = y * W + x;
      if (!mask[pi]) {
        out[idx] = cfg.ambientK;
        weight[idx] = 0;
        continue;
      }
      const tau = tauField[pi];
      // 已提供预校正帧时直接重采样，否则在此做辐射反演
      const corrected = inp.correctedFrame
        ? inp.correctedFrame[pi]
        : correctTempK(tempK[pi], {
            emissivity: cfg.emissivityNominal,
            transmittance: tau,
            ambientK: cfg.ambientK,
            smokeTempK: cfg.smokeTempK,
          });
      out[idx] = corrected;
      // 可见性权重：烟尘越重权重越低；硬遮挡为 0
      weight[idx] = 0.25 + 0.75 * tau;
    }
  }

  return { tempK: out, weight, yawRef: projPose.yaw };
}

/**
 * 把局部 phi 基准的展开图旋转到本体规范坐标。
 * 合成器约定：phiBody = phiLocal + yaw，即 localCol = canonCol - shift。
 */
export function rotateToCanonical(map: UnwrapMap, yaw: number): { tempK: Float32Array; weight: Float32Array } {
  const shift = Math.round((yaw / (Math.PI * 2)) * MAP_W) % MAP_W;
  const t = new Float32Array(MAP_W * MAP_H);
  const w = new Float32Array(MAP_W * MAP_H);
  for (let row = 0; row < MAP_H; row++) {
    for (let col = 0; col < MAP_W; col++) {
      const localCol = (col - shift + MAP_W) % MAP_W;
      t[row * MAP_W + col] = map.tempK[row * MAP_W + localCol];
      w[row * MAP_W + col] = map.weight[row * MAP_W + localCol];
    }
  }
  return { tempK: t, weight: w };
}

/** 辐射域加权 EMA 融合（同一块耐材跨帧累积） */
export function fuseMaps(
  fused: { tempK: Float32Array; confidence: Float32Array; maxTempK: Float32Array },
  canonTemp: Float32Array,
  canonWeight: Float32Array,
  alpha: number,
): void {
  for (let i = 0; i < fused.tempK.length; i++) {
    const w = canonWeight[i];
    if (w <= 0) continue;
    if (fused.confidence[i] === 0) {
      fused.tempK[i] = canonTemp[i];
      fused.maxTempK[i] = canonTemp[i];
    } else {
      const a = alpha * w;
      const mOld = m4(fused.tempK[i]);
      const mNew = m4(canonTemp[i]);
      const m = mOld * (1 - a) + mNew * a;
      fused.tempK[i] = Math.pow(Math.max(0, m), 0.25);
      if (canonTemp[i] > fused.maxTempK[i]) fused.maxTempK[i] = canonTemp[i];
    }
    fused.confidence[i] = Math.min(1, fused.confidence[i] + w * 0.15);
  }
}
