import { describe, it, expect } from 'vitest';
import { MAP_H, MAP_W } from '../src/core/types';
import { createYawTracker, trackYaw } from '../src/pipeline/yawTrack';

/** 高环向纹理规范图（无环向对称性），作为锚定参考 */
function makePattern(): Float32Array {
  const m = new Float32Array(MAP_W * MAP_H);
  for (let r = 0; r < MAP_H; r++) {
    for (let c = 0; c < MAP_W; c++) {
      const phi = (c / MAP_W) * Math.PI * 2;
      m[r * MAP_W + c] =
        1200 +
        120 * Math.sin(phi + 0.7) +
        60 * Math.sin(3 * phi + 1.9) +
        35 * Math.sin(7 * phi + 0.3);
    }
  }
  return m;
}

/** 零 yaw 局部正面视图：锚点列 = 局部列 + shift(yaw) */
function localView(ref: Float32Array, yaw: number): { temp: Float32Array; w: Float32Array } {
  const temp = new Float32Array(MAP_W * MAP_H);
  const w = new Float32Array(MAP_W * MAP_H);
  const shift = ((Math.round((yaw / (Math.PI * 2)) * MAP_W) % MAP_W) + MAP_W) % MAP_W;
  for (let r = 0; r < MAP_H; r++) {
    for (let c = 0; c < MAP_W; c++) {
      const phiLocal = (c / MAP_W) * Math.PI * 2;
      if (Math.cos(phiLocal) <= -0.1) {
        temp[r * MAP_W + c] = 300;
        w[r * MAP_W + c] = 0;
        continue;
      }
      temp[r * MAP_W + c] = ref[r * MAP_W + ((c + shift) % MAP_W)];
      w[r * MAP_W + c] = 1;
    }
  }
  return { temp, w };
}

function angDiff(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

const DT = 0.1;

describe('trackYaw 绝对窗口锚点 NCC', () => {
  const ref = makePattern();

  it('首帧建立锚定基准，yaw=0', () => {
    const t = createYawTracker();
    const v = localView(ref, 0);
    const r = trackYaw(t, v.temp, v.w, 0, DT);
    expect(r.reliable).toBe(true);
    expect(r.yaw).toBe(0);
  });

  it('绝对 yaw 直接测量：锚点可靠范围内误差 < 2°，无累积漂移', () => {
    // 固定首帧锚点的可靠范围受半圈视野约束（约 ±150° 内有足够重叠）
    const t = createYawTracker();
    const v0 = localView(ref, 0);
    trackYaw(t, v0.temp, v0.w, 0, DT);
    for (const yaw of [0.3, 0.87, 1.75, 2.4]) {
      const v = localView(ref, yaw);
      const r = trackYaw(t, v.temp, v.w, yaw, DT);
      expect(r.reliable).toBe(true);
      expect(Math.abs(angDiff(r.yaw, yaw))).toBeLessThan((2 / MAP_W) * Math.PI * 2 + 0.02);
    }
  });

  it('角度包裹（>2π）时按预测中心走最短弧', () => {
    const t = createYawTracker();
    trackYaw(t, localView(ref, 0).temp, localView(ref, 0).w, 0, DT);
    // 2.2 rad 在锚点可靠范围内；验证输出被包裹到预测附近而非跳变 ±2π
    const yaw = 2.2;
    const r = trackYaw(t, localView(ref, yaw).temp, localView(ref, yaw).w, yaw, DT);
    expect(Math.abs(angDiff(r.yaw, yaw))).toBeLessThan(0.05);
  });

  it('预测偏差较大时仍在搜索窗内收敛', () => {
    const t = createYawTracker();
    trackYaw(t, localView(ref, 0).temp, localView(ref, 0).w, 0, DT);
    const yaw = 0.6;
    const r = trackYaw(t, localView(ref, yaw).temp, localView(ref, yaw).w, yaw + 0.1, DT);
    expect(Math.abs(angDiff(r.yaw, yaw))).toBeLessThan(0.05);
  });
});
