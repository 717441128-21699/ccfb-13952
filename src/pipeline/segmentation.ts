/**
 * 帧分割：从原始温度矩阵提取包壁掩码
 *
 * 三重约束，专门解决"钩子误判"与"半遮挡"：
 *  1. 温度阈值得到热像素候选
 *  2. 连通域分析 + 几何包络重叠率：包壁是最大且贴合截锥包络的域
 *  3. 包口线之上的独立高温域（天车钩子）一律剔除
 * 输出掩码 + 占用率，供位姿估计与质量门控使用。
 */
import type { LadleGeometry, LadlePose } from '../core/types';
import { projectEnvelope } from '../core/geometry';

export interface SegmentationResult {
  mask: Uint8Array;
  rejectedHookPixels: number;
  /** 掩码像素数 / 期望包络像素面积 */
  occupancy: number;
  /** 掩码包围盒 */
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

interface Component {
  size: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  keep: boolean;
  isHook: boolean;
}

/** 4-邻域连通域（迭代栈），逐像素记录组件 id */
export function labelComponents(hot: Uint8Array, W: number, H: number): { labels: Int32Array; comps: Component[] } {
  const labels = new Int32Array(W * H).fill(-1);
  const comps: Component[] = [];
  const stack: number[] = [];
  for (let i = 0; i < W * H; i++) {
    if (hot[i] === 0 || labels[i] >= 0) continue;
    const id = comps.length;
    const c: Component = { size: 0, minX: W, maxX: 0, minY: H, maxY: 0, keep: false, isHook: false };
    labels[i] = id;
    stack.push(i);
    while (stack.length) {
      const p = stack.pop() as number;
      const x = p % W;
      const y = (p / W) | 0;
      c.size++;
      if (x < c.minX) c.minX = x;
      if (x > c.maxX) c.maxX = x;
      if (y < c.minY) c.minY = y;
      if (y > c.maxY) c.maxY = y;
      const nb = [p - 1, p + 1, p - W, p + W];
      for (const q of nb) {
        if (q < 0 || q >= W * H || labels[q] >= 0 || hot[q] === 0) continue;
        if (Math.abs((q % W) - x) > 1) continue;
        labels[q] = id;
        stack.push(q);
      }
    }
    comps.push(c);
  }
  return { labels, comps };
}

/** 生成截锥包络掩码（期望的钢包投影区域） */
export function envelopeMask(g: LadleGeometry, pose: LadlePose, W: number, H: number): Uint8Array {
  const env = projectEnvelope(g, pose);
  const out = new Uint8Array(W * H);
  const { mouth, bottom } = env;
  const yTop = mouth.cy - mouth.ry;
  const yBot = bottom.cy + bottom.ry;
  for (let y = Math.max(0, Math.floor(yTop)); y < Math.min(H, Math.ceil(yBot)); y++) {
    const t = (y - yTop) / Math.max(1e-6, yBot - yTop);
    const halfW = mouth.rx * (1 - t) + bottom.rx * t;
    const cxLine = mouth.cx * (1 - t) + bottom.cx * t;
    const x0 = Math.max(0, Math.floor(cxLine - halfW));
    const x1 = Math.min(W - 1, Math.ceil(cxLine + halfW));
    for (let x = x0; x <= x1; x++) out[y * W + x] = 1;
  }
  return out;
}

export function segmentFrame(
  tempK: Float32Array,
  W: number,
  H: number,
  thresholdK: number,
  g: LadleGeometry,
  predicted: LadlePose,
): SegmentationResult {
  const env = envelopeMask(g, predicted, W, H);
  const envArea = env.reduce((a, b) => a + b, 0);
  const mouthLine = projectEnvelope(g, predicted).mouth.cy;

  const hot = new Uint8Array(W * H);
  for (let i = 0; i < tempK.length; i++) {
    if (tempK[i] >= thresholdK) hot[i] = 1;
  }
  const { labels, comps } = labelComponents(hot, W, H);

  let rejectedHookPixels = 0;
  for (const c of comps) {
    let overlap = 0;
    let aboveMouth = 0;
    for (let y = c.minY; y <= c.maxY; y++) {
      for (let x = c.minX; x <= c.maxX; x++) {
        const idx = y * W + x;
        if (env[idx]) overlap++;
        if (y < mouthLine) aboveMouth++;
      }
    }
    const overlapRatio = overlap / c.size;
    const aboveRatio = aboveMouth / c.size;
    const isHook = aboveRatio > 0.7 && overlapRatio < 0.25;
    if (isHook) {
      c.isHook = true;
      rejectedHookPixels += c.size;
      continue;
    }
    c.keep = overlapRatio >= 0.3 || (c.size > 0.04 * envArea && overlapRatio >= 0.12);
  }

  const mask = new Uint8Array(W * H);
  let minX = W;
  let maxX = 0;
  let minY = H;
  let maxY = 0;
  let wallPixels = 0;
  for (let i = 0; i < W * H; i++) {
    if (!hot[i] || !env[i]) continue;
    const c = comps[labels[i]];
    if (!c.keep) continue;
    mask[i] = 1;
    wallPixels++;
    const x = i % W;
    const y = (i / W) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  return {
    mask,
    rejectedHookPixels,
    occupancy: envArea > 0 ? wallPixels / envArea : 0,
    bbox: wallPixels > 0 ? { x0: minX, y0: minY, x1: maxX, y1: maxY } : { x0: 0, y0: 0, x1: 0, y1: 0 },
  };
}
