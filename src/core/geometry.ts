/**
 * 钢包几何与投影模型
 *
 * 钢包外壁 = 回转截锥体：
 *   r(h) = rBottom + (rTop-rBottom) * h/H,   h ∈ [0,H]（h=0 底部, h=H 包口）
 * 规范表面坐标 (phi, h)：环向角 phi ∈ [0, 2π)，高度 h。
 *
 * 位姿：先绕自身竖轴自转 yaw，再施加 tiltX/tiltZ，最后平移到 (cx,cy) 并按 scale 投影像素。
 * 本模块同时服务合成器（正向投影）与跟踪/展开（逆向查询），保证几何自洽。
 */
import type { LadleGeometry, LadlePose, Vec2 } from './types';
import { MAP_H, MAP_W } from './types';

export const DEFAULT_GEOMETRY: LadleGeometry = {
  rTop: 1.75,
  rBottom: 1.55,
  height: 3.4,
};

/** 规范坐标点（phi 弧度, h 米） */
export interface SurfacePoint {
  phi: number;
  h: number;
}

/** 表面点 -> 钢包局部三维坐标（y 向上，x-z 水平面） */
export function surfaceToLocal(p: SurfacePoint, g: LadleGeometry): Vec3 {
  const r = g.rBottom + ((g.rTop - g.rBottom) * p.h) / g.height;
  return {
    x: r * Math.sin(p.phi),
    y: p.h - g.height / 2,
    z: r * Math.cos(p.phi),
  };
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

function rotY(v: Vec3, a: number): Vec3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: c * v.x + s * v.z, y: v.y, z: -s * v.x + c * v.z };
}

function rotX(v: Vec3, a: number): Vec3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: v.x, y: c * v.y - s * v.z, z: s * v.y + c * v.z };
}

function rotZ(v: Vec3, a: number): Vec3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: c * v.x - s * v.y, y: s * v.x + c * v.y, z: v.z };
}

/** 局部三维 -> 屏幕像素（弱透视，z 仅用于可见性判断）。相机位于 +z，depth>0 为可见面 */
export function localToScreen(v: Vec3, pose: LadlePose): { x: number; y: number; depth: number } {
  let p = rotY(v, pose.yaw);
  p = rotX(p, pose.tiltX);
  p = rotZ(p, pose.tiltZ);
  return {
    x: pose.cx + p.x * pose.scale,
    y: pose.cy - p.y * pose.scale,
    depth: p.z,
  };
}

/** 表面点 -> 屏幕，depth>0 为朝向相机的可见面 */
export function projectSurface(p: SurfacePoint, g: LadleGeometry, pose: LadlePose) {
  return localToScreen(surfaceToLocal(p, g), pose);
}

export interface ProjectedEnvelope {
  /** 包口椭圆 */
  mouth: { cx: number; cy: number; rx: number; ry: number };
  /** 包底椭圆 */
  bottom: { cx: number; cy: number; rx: number; ry: number };
  /** 两侧轮廓母线端点（屏幕） */
  leftSide: [Vec2, Vec2];
  rightSide: [Vec2, Vec2];
}

/** 计算包口/包底椭圆与两侧母线，供分割约束与渲染 */
export function projectEnvelope(g: LadleGeometry, pose: LadlePose): ProjectedEnvelope {
  const ring = (h: number) => {
    const pts: Vec3[] = [];
    for (let i = 0; i < 64; i++) {
      const phi = (i / 64) * Math.PI * 2;
      pts.push(surfaceToLocal({ phi, h }, g));
    }
    const sp = pts.map((p) => localToScreen(p, pose));
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let sx = 0;
    let sy = 0;
    for (const q of sp) {
      minX = Math.min(minX, q.x);
      maxX = Math.max(maxX, q.x);
      minY = Math.min(minY, q.y);
      maxY = Math.max(maxY, q.y);
      sx += q.x;
      sy += q.y;
    }
    return { cx: sx / sp.length, cy: sy / sp.length, rx: (maxX - minX) / 2, ry: (maxY - minY) / 2 };
  };
  const mouth = ring(g.height);
  const bottom = ring(0);

  const side = (sign: 1 | -1): [Vec2, Vec2] => {
    // 轮廓母线位于 phi = ±π/2 附近（屏幕 x 极值），取极值点
    let best0: Vec2 = { x: 0, y: 0 };
    let best1: Vec2 = { x: 0, y: 0 };
    let ex0 = -Infinity;
    let ex1 = -Infinity;
    for (let i = 0; i < 128; i++) {
      const phi = (i / 128) * Math.PI * 2;
      const a = projectSurface({ phi, h: 0 }, g, pose);
      const b = projectSurface({ phi, h: g.height }, g, pose);
      const k0 = sign * a.x;
      const k1 = sign * b.x;
      if (k0 > ex0) {
        ex0 = k0;
        best0 = { x: a.x, y: a.y };
      }
      if (k1 > ex1) {
        ex1 = k1;
        best1 = { x: b.x, y: b.y };
      }
    }
    return [best0, best1];
  };

  return { mouth, bottom, leftSide: side(-1), rightSide: side(1) };
}

/**
 * 展开图查找表：对每个展开像素 (icol,irow) 给出规范表面坐标。
 * icol: 0..MAP_W-1 -> phi；irow: 0..MAP_H-1 -> h（irow=0 底部）。
 * 注意：phi 基准是钢包本体坐标，帧间对齐通过 yaw 旋转在别处完成。
 */
export function canonicalSurfaceAt(icol: number, irow: number, g: LadleGeometry): SurfacePoint {
  return {
    phi: (icol / MAP_W) * Math.PI * 2,
    h: ((irow + 0.5) / MAP_H) * g.height,
  };
}

/** 环向角差值，归一化到 [-π, π] */
export function angleDiff(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** 展开像素 -> 砖格编号 */
export function brickIndex(icol: number, irow: number): { col: number; row: number } {
  return {
    col: Math.min(BRICK_COLS - 1, Math.floor((icol / MAP_W) * BRICK_COLS)),
    row: Math.min(BRICK_ROWS - 1, Math.floor((irow / MAP_H) * BRICK_ROWS)),
  };
}

import { BRICK_COLS, BRICK_ROWS } from './types';
