/**
 * 钢包位姿跟踪
 *
 * 回转截锥体的投影轮廓与自转 yaw 无关，因此拆成两个独立问题：
 *  - 位姿 (cx,cy,scale,tiltZ)：由掩码包围盒/质心拟合，恒速模型预测，EMA 平滑
 *  - yaw：见 yawTrack，靠热纹理环形相关匹配
 * 硬遮挡（占用率骤降）时冻结拟合、按速度外推，避免被遮挡带带偏。
 */
import type { LadleGeometry, LadlePose } from '../core/types';

export interface TrackState {
  pose: LadlePose;
  velYaw: number;
  lastT: number;
  initialized: boolean;
  /** 上一帧占用率，用于遮挡判定 */
  lastOccupancy: number;
  occluded: boolean;
}

export function createTrackState(initial: LadlePose): TrackState {
  return { pose: { ...initial }, velYaw: 0, lastT: 0, initialized: true, lastOccupancy: 1, occluded: false };
}

/**
 * 由掩码质心与面积拟合位姿。
 * 质心比 bbox 中心对侧移/部分遮挡更稳健；尺度由掩码面积反推（回转壁投影面积）。
 */
export function fitPoseFromMask(
  bbox: { x0: number; y0: number; x1: number; y1: number },
  g: LadleGeometry,
  W: number,
  H: number,
  prev: LadlePose,
  mask?: Uint8Array,
): LadlePose {
  const bw = Math.max(1, bbox.x1 - bbox.x0);
  const bh = Math.max(1, bbox.y1 - bbox.y0);
  let cx = (bbox.x0 + bbox.x1) / 2;
  let cy = (bbox.y0 + bbox.y1) / 2;
  const bboxArea = bw * bh * 0.7;
  let area = bboxArea;

  if (mask && mask.length === W * H) {
    let m00 = 0;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      m00++;
      sx += i % W;
      sy += (i / W) | 0;
    }
    if (m00 > 30) {
      const centroidX = sx / m00;
      const centroidY = sy / m00;
      const bboxCx = (bbox.x0 + bbox.x1) / 2;
      const bboxCy = (bbox.y0 + bbox.y1) / 2;
      area = m00;
      // 掩码相对 bbox 面积偏小说明被遮挡/侧移，此时更信任质心；完整可见信任 bbox 中心
      const fillRatio = m00 / Math.max(1, bw * bh);
      const wCentroid = fillRatio < 0.7 ? 0.7 : 0.25;
      cx = bboxCx * (1 - wCentroid) + centroidX * wCentroid;
      cy = bboxCy * (1 - wCentroid) + centroidY * wCentroid;
    }
  }

  // 高度法 sH 对侧移/倾斜最稳健（实测误差 <5%）；宽度法易被摆动压缩，面积法抗遮挡。
  const AREA_COEF = 11.6;
  const sFromArea = Math.sqrt(area / AREA_COEF);
  const sFromW = bw / (2 * g.rTop);
  const sFromH = bh / g.height;
  const fillRatio = area / Math.max(1, bw * bh);
  // 完整可见时高度为主、宽度辅助；掩码被压缩时进一步提高高度/面积权重
  const trustBbox = fillRatio >= 0.7 ? 0.25 : 0.1;
  const scale =
    trustBbox * sFromW + 0.55 * sFromH + (1 - trustBbox - 0.55) * sFromArea;

  return {
    cx,
    cy,
    scale,
    tiltX: prev.tiltX,
    tiltZ: 0,
    yaw: prev.yaw,
  };
}

/** 恒速模型预测（渲染前先给分割器提供预测包络） */
export function predictPose(state: TrackState, _tSec: number, dt: number): LadlePose {
  const p = state.pose;
  return { ...p, yaw: p.yaw + state.velYaw * dt };
}

const EMA_POS = 0.75;
const EMA_SCALE = 0.6;
/** 单帧 yaw 观测相对预测的最大合理跳变（弧度，约 30°） */
const YAW_GATE = Math.PI / 6;

function ema(a: number, b: number, k: number): number {
  return a + k * (b - a);
}

/**
 * 用本帧观测更新跟踪状态。
 * occupancy < 0.45 视为硬遮挡：冻结平移/尺度，yaw 仅按速度外推。
 */
export function updateTrack(
  state: TrackState,
  observed: LadlePose,
  measuredYaw: number | null,
  occupancy: number,
  tSec: number,
): TrackState {
  const dt = Math.max(1e-3, tSec - state.lastT);
  const occluded = occupancy < 0.45;
  const next: LadlePose = { ...state.pose };

  if (occluded) {
    next.yaw = state.pose.yaw + state.velYaw * dt;
  } else {
    next.cx = ema(state.pose.cx, observed.cx, EMA_POS);
    next.cy = ema(state.pose.cy, observed.cy, EMA_POS);
    next.scale = ema(state.pose.scale, observed.scale, EMA_SCALE);
    next.tiltZ = ema(state.pose.tiltZ, observed.tiltZ, EMA_POS);
    next.tiltX = observed.tiltX;
    if (measuredYaw !== null) {
      // NCC 全环直接测量：门限异常跳变后直接采用，速度仅用于遮挡期外推
      const predictedYaw = state.pose.yaw + state.velYaw * dt;
      let dg = measuredYaw - predictedYaw;
      if (dg > Math.PI) dg -= Math.PI * 2;
      if (dg < -Math.PI) dg += Math.PI * 2;
      const newYaw = Math.abs(dg) > YAW_GATE
        ? predictedYaw + Math.sign(dg) * YAW_GATE
        : measuredYaw;
      let d = newYaw - state.pose.yaw;
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      const instVel = d / dt;
      state.velYaw = ema(state.velYaw, instVel, 0.3);
      next.yaw = newYaw;
    } else {
      next.yaw = state.pose.yaw + state.velYaw * dt;
    }
  }

  state.pose = next;
  state.lastT = tSec;
  state.lastOccupancy = occupancy;
  state.occluded = occluded;
  return state;
}

/** 掩码二阶矩 -> 面内滚转角 */
export function maskTiltZ(mask: Uint8Array, W: number, _H: number): number {
  let m00 = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    m00++;
    sx += i % W;
    sy += (i / W) | 0;
  }
  if (m00 < 20) return 0;
  const mx = sx / m00;
  const my = sy / m00;
  let mxx = 0;
  let mxy = 0;
  let myy = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const dx = (i % W) - mx;
    const dy = ((i / W) | 0) - my;
    mxx += dx * dx;
    mxy += dx * dy;
    myy += dy * dy;
  }
  // 主轴角
  return 0.5 * Math.atan2(2 * mxy, mxx - myy);
}

export function initialPose(g: LadleGeometry, W: number, H: number): LadlePose {
  return {
    cx: W / 2,
    cy: H / 2,
    scale: (H * 0.42) / g.height,
    tiltX: 0,
    tiltZ: 0,
    yaw: 0,
  };
}
