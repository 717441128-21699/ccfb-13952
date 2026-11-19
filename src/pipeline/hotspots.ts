/**
 * 热点检测与 3 秒超阈报警状态机
 *
 * 热点在融合图上检测（不依赖单帧可见性，遮挡期间热点不丢）：
 *  - 局部极大值 + 温度门限 + 非极大抑制，得到稳定热点并编号
 * 报警：任一融合像素真实温度超阈且持续 holdSec（3s），输出一次报警事件，
 * 并记录超阈起点到报警的实测时延。
 */
import type { AlarmEvent, FusedMap, Hotspot, PipelineConfig } from '../core/types';
import { MAP_H, MAP_W, BRICK_COLS, BRICK_ROWS } from '../core/types';
import { brickIndex } from '../core/geometry';

export interface HotspotDetector {
  nextId: number;
  /** 已跟踪热点（按规范位置匹配复用 id） */
  tracked: Hotspot[];
}

export function createDetector(): HotspotDetector {
  return { nextId: 1, tracked: [] };
}

const NMS_RADIUS_COL = 14;
const NMS_RADIUS_ROW = 5;

function angularDistCol(a: number, b: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, MAP_W - d);
}

/** 在融合图上检测热点，带跨帧 id 关联 */
export function detectHotspots(
  fused: FusedMap,
  detector: HotspotDetector,
  minTempK: number,
  topN = 6,
): Hotspot[] {
  const cand: Hotspot[] = [];
  for (let row = 2; row < MAP_H - 2; row++) {
    for (let col = 0; col < MAP_W; col++) {
      const idx = row * MAP_W + col;
      if (fused.confidence[idx] < 0.25) continue;
      const t = fused.tempK[idx];
      if (t < minTempK) continue;
      let isMax = true;
      for (let dr = -2; dr <= 2 && isMax; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          if (dr === 0 && dc === 0) continue;
          const cc = (col + dc + MAP_W) % MAP_W;
          const rr = row + dr;
          if (rr < 0 || rr >= MAP_H) continue;
          if (fused.tempK[rr * MAP_W + cc] > t) {
            isMax = false;
            break;
          }
        }
      }
      if (!isMax) continue;
      const b = brickIndex(col, row);
      cand.push({
        id: -1,
        phiDeg: (col / MAP_W) * 360,
        hNorm: (row + 0.5) / MAP_H,
        tempK: t,
        brickCol: b.col,
        brickRow: b.row,
      });
    }
  }

  cand.sort((a, b) => b.tempK - a.tempK);
  const picked: Hotspot[] = [];
  for (const c of cand) {
    if (picked.length >= topN) break;
    const crowded = picked.some(
      (p) =>
        angularDistCol(p.phiDeg / 360 * MAP_W, c.phiDeg / 360 * MAP_W) < NMS_RADIUS_COL &&
        Math.abs(p.hNorm - c.hNorm) * MAP_H < NMS_RADIUS_ROW * 2,
    );
    if (crowded) continue;
    picked.push(c);
  }

  // id 关联：与既有跟踪点位置接近则复用
  const used = new Set<number>();
  for (const p of picked) {
    let bestId = -1;
    let bestD = Infinity;
    for (const old of detector.tracked) {
      if (used.has(old.id)) continue;
      const d =
        angularDistCol((old.phiDeg / 360) * MAP_W, (p.phiDeg / 360) * MAP_W) +
        Math.abs(old.hNorm - p.hNorm) * MAP_H * 0.5;
      if (d < bestD) {
        bestD = d;
        bestId = old.id;
      }
    }
    if (bestId >= 0 && bestD < 18) {
      p.id = bestId;
      used.add(bestId);
    } else {
      p.id = detector.nextId++;
    }
  }
  detector.tracked = picked.map((p) => ({ ...p }));
  return picked;
}

interface OverThreshold {
  idx: number;
  sinceT: number;
  alarmed: boolean;
}

/** 报警状态机：逐像素跟踪超阈持续时间 */
export class AlarmMonitor {
  private active = new Map<number, OverThreshold>();

  reset(): void {
    this.active.clear();
  }

  update(
    fused: FusedMap,
    frameIndex: number,
    tSec: number,
    cfg: PipelineConfig,
    hotspots: Hotspot[],
  ): AlarmEvent[] {
    const events: AlarmEvent[] = [];
    const holdFrames = Math.max(1, Math.round(cfg.alarmHoldSec * 10));
    const now = new Set<number>();

    for (let i = 0; i < fused.tempK.length; i++) {
      if (fused.tempK[i] >= cfg.alarmThresholdK && fused.confidence[i] > 0.2) now.add(i);
    }

    // 新增超阈像素
    for (const idx of now) {
      if (!this.active.has(idx)) {
        this.active.set(idx, { idx, sinceT: tSec, alarmed: false });
      }
    }
    // 消失的删除
    for (const key of [...this.active.keys()]) {
      if (!now.has(key)) this.active.delete(key);
    }

    for (const [, st] of this.active) {
      const duration = tSec - st.sinceT;
      if (!st.alarmed && duration + 1e-6 >= cfg.alarmHoldSec) {
        st.alarmed = true;
        const idx = st.idx;
        const col = idx % MAP_W;
        const row = (idx / MAP_W) | 0;
        const nearest = nearestHotspot(col, row, hotspots);
        events.push({
          frameIndex,
          tSec,
          phiDeg: (col / MAP_W) * 360,
          hNorm: (row + 0.5) / MAP_H,
          tempK: fused.tempK[idx],
          thresholdK: cfg.alarmThresholdK,
          latencyMs: duration * 1000,
          hotspotId: nearest?.id ?? -1,
        });
      }
    }
    void holdFrames;
    return events;
  }
}

function nearestHotspot(col: number, row: number, hotspots: Hotspot[]): Hotspot | null {
  let best: Hotspot | null = null;
  let bestD = Infinity;
  for (const h of hotspots) {
    const hc = (h.phiDeg / 360) * MAP_W;
    const hr = h.hNorm * MAP_H;
    const d = angularDistCol(hc, col) + Math.abs(hr - row) * 0.5;
    if (d < bestD) {
      bestD = d;
      best = h;
    }
  }
  return best;
}

/** 砖格统计：每块砖的最高/均值温度 */
export function brickStatistics(fused: FusedMap) {
  const maxT = new Float32Array(BRICK_COLS * BRICK_ROWS);
  const sumT = new Float64Array(BRICK_COLS * BRICK_ROWS);
  const cnt = new Uint32Array(BRICK_COLS * BRICK_ROWS);
  for (let row = 0; row < MAP_H; row++) {
    for (let col = 0; col < MAP_W; col++) {
      const idx = row * MAP_W + col;
      if (fused.confidence[idx] < 0.2) continue;
      const b = brickIndex(col, row);
      const bi = b.row * BRICK_COLS + b.col;
      cnt[bi]++;
      sumT[bi] += fused.tempK[idx];
      if (fused.tempK[idx] > maxT[bi]) maxT[bi] = fused.tempK[idx];
    }
  }
  return { maxT, sumT, cnt };
}
