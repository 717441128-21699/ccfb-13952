/**
 * 热图渲染：把温度矩阵绘成伪彩 canvas。
 * 用 ImageData 逐像素上色，避免每帧创建渐变对象；色带为铁红（黑→红→黄→白）。
 */
import { MAP_H, MAP_W } from '../core/types';

const LUT_SIZE = 256;
let lut: Uint8ClampedArray | null = null;

/** 铁红色带查找表 */
function buildLut(): Uint8ClampedArray {
  if (lut) return lut;
  lut = new Uint8ClampedArray(LUT_SIZE * 3);
  for (let i = 0; i < LUT_SIZE; i++) {
    const t = i / (LUT_SIZE - 1);
    let r: number, g: number, b: number;
    if (t < 0.33) {
      const k = t / 0.33;
      r = 20 + k * 180; g = 10 + k * 30; b = 30 + k * 10;
    } else if (t < 0.66) {
      const k = (t - 0.33) / 0.33;
      r = 200 + k * 55; g = 40 + k * 150; b = 40 - k * 20;
    } else {
      const k = (t - 0.66) / 0.34;
      r = 255; g = 190 + k * 65; b = 20 + k * 235;
    }
    lut[i * 3] = r;
    lut[i * 3 + 1] = g;
    lut[i * 3 + 2] = b;
  }
  return lut;
}

export interface HeatRange {
  minK: number;
  maxK: number;
}

/** 渲染展开图（360×96）到指定 canvas，可放大 */
export function renderUnwrapped(
  canvas: HTMLCanvasElement,
  tempK: Float32Array,
  weight: Float32Array,
  range: HeatRange,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const table = buildLut();
  const img = ctx.createImageData(MAP_W, MAP_H);
  const span = Math.max(1, range.maxK - range.minK);
  for (let i = 0; i < MAP_W * MAP_H; i++) {
    const visible = weight[i] > 0.05;
    const norm = Math.max(0, Math.min(1, (tempK[i] - range.minK) / span));
    const li = Math.round(norm * (LUT_SIZE - 1)) * 3;
    const o = i * 4;
    if (visible) {
      img.data[o] = table[li];
      img.data[o + 1] = table[li + 1];
      img.data[o + 2] = table[li + 2];
      img.data[o + 3] = 255;
    } else {
      // 无数据区深灰
      img.data[o] = 28; img.data[o + 1] = 28; img.data[o + 2] = 34; img.data[o + 3] = 255;
    }
  }
  // 先放到离屏小画布再放大，保证平滑且坐标正确
  const off = document.createElement('canvas');
  off.width = MAP_W;
  off.height = MAP_H;
  off.getContext('2d')!.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
}

/** 渲染原始帧温度矩阵（W×H，左上原点行优先） */
export function renderFrame(
  canvas: HTMLCanvasElement,
  tempK: Float32Array,
  W: number,
  H: number,
  range: HeatRange,
  mask?: Uint8Array,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const table = buildLut();
  const img = ctx.createImageData(W, H);
  const span = Math.max(1, range.maxK - range.minK);
  for (let i = 0; i < W * H; i++) {
    const norm = Math.max(0, Math.min(1, (tempK[i] - range.minK) / span));
    const li = Math.round(norm * (LUT_SIZE - 1)) * 3;
    const o = i * 4;
    img.data[o] = table[li];
    img.data[o + 1] = table[li + 1];
    img.data[o + 2] = table[li + 2];
    img.data[o + 3] = mask && !mask[i] ? 90 : 255;
  }
  const off = document.createElement('canvas');
  off.width = W;
  off.height = H;
  off.getContext('2d')!.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
}

export const kToC = (k: number): number => k - 273.15;
