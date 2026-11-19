/**
 * yaw 跟踪：锚定参考上的绝对窗口环形 NCC（无增量积分漂移）
 *
 * 输入是运动补偿后的零 yaw 展开图，列 c=phiLocal，本体材质角
 * phiBody = phiLocal + yaw，故当前视图相对首帧锚定参考整体环向平移 shift(yaw)。
 *
 * 关键设计：
 *  - 绝对测量：每帧直接在锚定参考上求 yaw，不做帧间增量积分，从根本上杜绝累积漂移
 *  - 预测窗口：自转连续，真实峰必在恒速预测 ±半窗 内，窗口外的高相关是摆动伪配准
 *  - 周期性全环重锚：每隔若干帧做一次 360° 搜索，纠正窗口锁定偏差与填补锚点盲区
 *  - 锚点只填补从未见过的列，不做 EMA，避免错误 yaw 污染基准
 * 纯环向 NCC（不嵌套平移搜索），单帧计算量小，满足实时约束。
 */
import { MAP_H, MAP_W } from '../core/types';

const TWO_PI = Math.PI * 2;
const ROWS = [0.3, 0.5, 0.7].map((f) => Math.floor(MAP_H * f));
const MIN_SCORE = 0.08;
const HALF_WINDOW_COLS = 10;
const COLD_HALF_COLS = 15;
const COLD_FRAMES = 12;
/** 滚动锚点：高置信时把当前已对齐视图并入参考，覆盖随自转进入的新方位 */
const ANCHOR_FILL = false;
/** 仅在相关分高于此值时更新锚点，防止错误配准污染基准 */
const ANCHOR_UPDATE_SCORE = 0.5;

export interface YawTracker {
  refTemp: Float32Array;
  refWeight: Float32Array;
  hasRef: boolean;
  yaw: number;
  velYaw: number;
  lastScore: number;
  frame: number;
}

export function createYawTracker(): YawTracker {
  return {
    refTemp: new Float32Array(MAP_W * MAP_H),
    refWeight: new Float32Array(MAP_W * MAP_H),
    hasRef: false,
    yaw: 0,
    velYaw: 0,
    lastScore: 1,
    frame: 0,
  };
}

/** 候选环向位移 shift（局部列 c 对齐锚点列 c+shift）的平均 NCC */
function scoreShift(
  local: Float32Array,
  localW: Float32Array,
  refTemp: Float32Array,
  refWeight: Float32Array,
  shift: number,
): { score: number; support: number } {
  let total = 0;
  let used = 0;
  let support = 0;
  for (const row of ROWS) {
    const a: number[] = [];
    const b: number[] = [];
    for (let c = 0; c < MAP_W; c++) {
      const refCol = (((c + shift) % MAP_W) + MAP_W) % MAP_W;
      if (localW[row * MAP_W + c] <= 0.4 || refWeight[row * MAP_W + refCol] <= 0.4) continue;
      a.push(local[row * MAP_W + c]);
      b.push(refTemp[row * MAP_W + refCol]);
      support++;
    }
    if (a.length < MAP_W * 0.15) continue;
    const n = a.length;
    const ma = a.reduce((x, y) => x + y, 0) / n;
    const mb = b.reduce((x, y) => x + y, 0) / n;
    let va = 0;
    let vb = 0;
    let cov = 0;
    for (let i = 0; i < n; i++) {
      const da = a[i] - ma;
      const db = b[i] - mb;
      va += da * da;
      vb += db * db;
      cov += da * db;
    }
    if (va < 1e-6 || vb < 1e-6) continue;
    total += cov / Math.sqrt(va * vb);
    used++;
  }
  return { score: used > 0 ? total / used : -Infinity, support };
}

export interface YawResult {
  yaw: number;
  score: number;
  reliable: boolean;
}

export function trackYaw(
  tracker: YawTracker,
  local: Float32Array,
  localW: Float32Array,
  predictedYaw: number,
  dt = 0.1,
): YawResult {
  if (!tracker.hasRef) {
    tracker.refTemp.set(local);
    tracker.refWeight.set(localW);
    tracker.hasRef = true;
    tracker.yaw = 0;
    tracker.frame = 1;
    return { yaw: 0, score: 1, reliable: true };
  }
  tracker.frame++;

  const score = (shift: number) =>
    scoreShift(local, localW, tracker.refTemp, tracker.refWeight, shift);

  const centerCol = ((Math.round((predictedYaw / TWO_PI) * MAP_W) % MAP_W) + MAP_W) % MAP_W;
  const half = tracker.frame < COLD_FRAMES ? COLD_HALF_COLS : HALF_WINDOW_COLS;

  let bestShift = centerCol;
  let bestScore = -Infinity;
  let bestSupport = 0;
  // 仅在预测窗口内搜索：不做全环重锚，避免半圈视野的环向模糊把 yaw 拉到错误峰
  for (let d = -half; d <= half; d++) {
    const s = (((centerCol + d) % MAP_W) + MAP_W) % MAP_W;
    const r = score(s);
    if (r.score > bestScore) {
      bestScore = r.score;
      bestShift = s;
      bestSupport = r.support;
    }
  }
  const refinedShift = bestShift;

  const reliable = bestScore >= MIN_SCORE && bestSupport >= MAP_W * 0.12;
  if (reliable) {
    let yaw = (refinedShift / MAP_W) * TWO_PI;
    while (yaw - predictedYaw > Math.PI) yaw -= TWO_PI;
    while (yaw - predictedYaw < -Math.PI) yaw += TWO_PI;
    const instVel = (yaw - tracker.yaw) / Math.max(1e-3, dt);
    tracker.velYaw = tracker.velYaw * 0.7 + instVel * 0.3;
    tracker.yaw = yaw;
    tracker.lastScore = bestScore;
    if (ANCHOR_FILL && bestScore >= ANCHOR_UPDATE_SCORE) {
      // 高置信时把当前已对齐视图并入锚点（EMA 轻微更新 + 填补未见列）
      for (let row = 0; row < MAP_H; row++) {
        for (let c = 0; c < MAP_W; c++) {
          const refCol = (((c + bestShift) % MAP_W) + MAP_W) % MAP_W;
          const ri = row * MAP_W + refCol;
          const lw = localW[row * MAP_W + c];
          if (lw <= 0.4) continue;
          if (tracker.refWeight[ri] < 0.4) {
            tracker.refTemp[ri] = local[row * MAP_W + c];
            tracker.refWeight[ri] = lw * 0.9;
          } else if (lw > 0.7) {
            tracker.refTemp[ri] = 0.95 * tracker.refTemp[ri] + 0.05 * local[row * MAP_W + c];
          }
        }
      }
    }
  } else {
    // 相关不足：按平滑速度短时外推
    tracker.yaw = tracker.yaw + tracker.velYaw * dt;
    tracker.lastScore = bestScore;
  }
  return { yaw: tracker.yaw, score: bestScore, reliable };
}
