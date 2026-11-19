/**
 * 包壁温度场模型（钢包本体规范坐标，与帧位姿无关）
 *
 * 组成：
 *  1. 高度方向基线（包口/包底附近温降）
 *  2. 环向缓变（钢包受热不均）
 *  3. 耐材砖格噪声与发射率差异（发射率差异不改变真实温度，但会改变相机读数，
 *     合成器据此产生纹理，跟踪器据此做 yaw 匹配）
 *  4. 磨损热点：高斯斑，幅值随包龄增长，模拟"越用越热"
 */
import type { LadleGeometry } from './types';
import { MAP_H, MAP_W, BRICK_COLS, BRICK_ROWS } from './types';
import { Rng } from './rng';
import { angleDiff } from './geometry';

export interface HotspotSpec {
  phiDeg: number;
  hNorm: number;
  /** 环向/纵向高斯标准差（规范单位） */
  sigmaPhiDeg: number;
  sigmaH: number;
  /** 该炉次的峰值温升 K（相对基线） */
  peakK: number;
}

export interface ThermalField {
  /** 展开空间真实壁温 K（MAP_W*MAP_H） */
  trueTempK: Float32Array;
  /** 发射率场（含砖格差异） */
  emissivity: Float32Array;
  hotspots: HotspotSpec[];
}

export interface ThermalFieldParams {
  ladleAge: number;
  baseTempK: number;
  hotspots: HotspotSpec[];
  seed: number;
}

/** 生成一炉次的稳态包壁温度场与发射率场 */
export function buildThermalField(_g: LadleGeometry, params: ThermalFieldParams): ThermalField {
  const rng = new Rng(params.seed);
  const n = MAP_W * MAP_H;
  const trueTempK = new Float32Array(n);
  const emissivity = new Float32Array(n);

  // 环向缓变相位（固定 2 个谐波）
  const phase1 = rng.range(0, Math.PI * 2);
  const phase2 = rng.range(0, Math.PI * 2);

  // 砖格级温度/发射率抖动（每块砖一个值）。真实耐材砖缝与砖体差异显著，
  // 是 yaw 环向匹配的主要高频特征，因此温度起伏取较大幅值。
  const brickTemp = new Float32Array(BRICK_COLS * BRICK_ROWS);
  const brickEps = new Float32Array(BRICK_COLS * BRICK_ROWS);
  for (let b = 0; b < brickTemp.length; b++) {
    brickTemp[b] = rng.gaussian(22);
    brickEps[b] = 0.92 + rng.gaussian(0.02);
  }

  for (let row = 0; row < MAP_H; row++) {
    const hNorm = (row + 0.5) / MAP_H;
    // 高度基线：中部最热，向包口/包底衰减
    const vertProfile = 1 - 0.35 * Math.pow(Math.abs(hNorm - 0.55) * 2, 1.6);
    for (let col = 0; col < MAP_W; col++) {
      const phi = (col / MAP_W) * Math.PI * 2;
      const bc = Math.min(BRICK_COLS - 1, Math.floor((col / MAP_W) * BRICK_COLS));
      const br = Math.min(BRICK_ROWS - 1, Math.floor((row / MAP_H) * BRICK_ROWS));
      const bi = br * BRICK_COLS + bc;

      const circum =
        22 * Math.sin(phi + phase1) + 12 * Math.sin(3 * phi + phase2) +
        8 * Math.sin(11 * phi + phase2 * 0.5) + rng.gaussian(2.5);
      let t = params.baseTempK * vertProfile + circum + brickTemp[bi];

      for (const hs of params.hotspots) {
        const dPhi = angleDiff(phi, (hs.phiDeg * Math.PI) / 180);
        const dh = hNorm - hs.hNorm;
        const sigPhi = (hs.sigmaPhiDeg * Math.PI) / 180;
        const g = Math.exp(-0.5 * ((dPhi / sigPhi) ** 2 + (dh / hs.sigmaH) ** 2));
        t += hs.peakK * g;
      }
      trueTempK[row * MAP_W + col] = t;
      emissivity[row * MAP_W + col] = Math.max(0.82, Math.min(0.97, brickEps[bi]));
    }
  }

  return { trueTempK, emissivity, hotspots: params.hotspots };
}

/** 双线性采样展开温度场（col 可跨 360 环绕） */
export function sampleField(field: Float32Array, col: number, row: number): number {
  const c0 = ((Math.floor(col) % MAP_W) + MAP_W) % MAP_W;
  const c1 = (c0 + 1) % MAP_W;
  const r0 = Math.max(0, Math.min(MAP_H - 1, Math.floor(row)));
  const r1 = Math.max(0, Math.min(MAP_H - 1, r0 + 1));
  const fc = col - Math.floor(col);
  const fr = row - r0;
  const a = field[r0 * MAP_W + c0] * (1 - fc) + field[r0 * MAP_W + c1] * fc;
  const b = field[r1 * MAP_W + c0] * (1 - fc) + field[r1 * MAP_W + c1] * fc;
  return a * (1 - fr) + b * fr;
}

export function fieldAt(phi: number, hNorm: number, field: Float32Array): number {
  const col = (((phi / (Math.PI * 2)) * MAP_W) % MAP_W + MAP_W) % MAP_W;
  const row = Math.max(0, Math.min(MAP_H - 1, hNorm * MAP_H - 0.5));
  return sampleField(field, col, row);
}

/** 随包龄线性增长的磨损热点配置（用于多炉次建档） */
export function agingHotspots(
  defs: Array<{ phiDeg: number; hNorm: number; basePeakK: number; growthK: number }>,
  ladleAge: number,
): HotspotSpec[] {
  return defs.map((d) => ({
    phiDeg: d.phiDeg,
    hNorm: d.hNorm,
    sigmaPhiDeg: 11,
    sigmaH: 0.09,
    peakK: d.basePeakK + d.growthK * (ladleAge - 1),
  }));
}
