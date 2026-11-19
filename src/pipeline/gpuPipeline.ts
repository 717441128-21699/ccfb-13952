/**
 * GPU 处理管线（浏览器生产路径）
 *
 * 每帧：GPU 完成分割/τ 估计/展开反演 -> CPU 复用同一套连通域、位姿、
 * yaw 相关、融合、热点与报警逻辑（与 CpuPipeline 结果同构）。
 * 通过 OffscreenCanvas 在 Worker 内运行，主线程零阻塞。
 */
import type {
  AlarmEvent,
  CampaignRecord,
  FrameResult,
  FusedMap,
  LadlePose,
  PipelineConfig,
  SequenceHeader,
} from '../core/types';
import { MAP_H, MAP_W } from '../core/types';
import { GpuEngine } from '../webgl/gpuEngine';
import { envelopeMask, labelComponents } from './segmentation';
import { projectEnvelope } from '../core/geometry';
import {
  createTrackState,
  fitPoseFromMask,
  initialPose,
  maskTiltZ,
  predictPose,
  updateTrack,
  type TrackState,
} from './tracker';
import { createYawTracker, trackYaw } from './yawTrack';
import { cleanReferenceByBand, fuseMaps, rotateToCanonical } from './unwrap';
import { AlarmMonitor, brickStatistics, createDetector, detectHotspots } from './hotspots';

export class GpuPipeline {
  private state: TrackState;
  private yawTracker = createYawTracker();
  private detector = createDetector();
  private alarm = new AlarmMonitor();
  private fused: FusedMap;
  private alarms: AlarmEvent[] = [];
  private frameResults: FrameResult[] = [];
  private frameCount = 0;
  private maxTempK = 0;
  private maxHotspot: CampaignRecord['hotspot'] = null;

  constructor(
    private engine: GpuEngine,
    private header: SequenceHeader,
    private cfg: PipelineConfig,
  ) {
    const init = initialPose(header.geometry, header.width, header.height);
    this.state = createTrackState(init);
    this.fused = {
      tempK: new Float32Array(MAP_W * MAP_H).fill(cfg.ambientK),
      confidence: new Float32Array(MAP_W * MAP_H),
      maxTempK: new Float32Array(MAP_W * MAP_H),
      yawRef: 0,
    };
  }

  /** CPU 侧钩子剔除（与 segmentation.ts 同一规则，输入改为 GPU 掩码） */
  private rejectHooks(gpuMask: Uint8Array, predicted: LadlePose): { mask: Uint8Array; rejected: number; occupancy: number; bbox: { x0: number; y0: number; x1: number; y1: number } } {
    const { width: W, height: H, geometry: g } = this.header;
    const env = envelopeMask(g, predicted, W, H);
    const envArea = env.reduce((a, b) => a + b, 0);
    const mouthLine = projectEnvelope(g, predicted).mouth.cy;
    const { labels, comps } = labelComponents(gpuMask, W, H);

    let rejected = 0;
    for (const c of comps) {
      let overlap = 0;
      let above = 0;
      for (let y = c.minY; y <= c.maxY; y++) {
        for (let x = c.minX; x <= c.maxX; x++) {
          const idx = y * W + x;
          if (env[idx]) overlap++;
          if (y < mouthLine) above++;
        }
      }
      const isHook = above / c.size > 0.7 && overlap / c.size < 0.25;
      if (isHook) {
        c.isHook = true;
        rejected += c.size;
        continue;
      }
      c.keep = overlap / c.size >= 0.3 || (c.size > 0.04 * envArea && overlap / c.size >= 0.12);
    }

    const mask = new Uint8Array(W * H);
    let minX = W;
    let maxX = 0;
    let minY = H;
    let maxY = 0;
    let wall = 0;
    for (let i = 0; i < W * H; i++) {
      if (!gpuMask[i] || !env[i]) continue;
      const c = comps[labels[i]];
      if (!c.keep) continue;
      mask[i] = 1;
      wall++;
      const x = i % W;
      const y = (i / W) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return {
      mask,
      rejected,
      occupancy: envArea > 0 ? wall / envArea : 0,
      bbox: wall > 0 ? { x0: minX, y0: minY, x1: maxX, y1: maxY } : { x0: 0, y0: 0, x1: 0, y1: 0 },
    };
  }

  process(tempK: Float32Array, tSec: number): FrameResult {
    const t0 = performance.now();
    const { width: W, height: H, geometry: g } = this.header;
    const dt = this.frameCount === 0 ? 1 / this.header.fps : tSec - this.state.lastT;
    const predicted = predictPose(this.state, tSec, dt);

    // 先粗分割拿参照与掩码（GPU 第一遍，预测位姿）
    const refs = cleanReferenceByBand(
      tempK,
      gpuThresholdMask(tempK, W, H, this.cfg.segmentThresholdK),
      null,
      W,
      H,
      12,
    );
    const gpu = this.engine.processFrame(tempK, predicted, g, this.cfg, refs);
    const seg = this.rejectHooks(gpu.mask, predicted);

    let measured: LadlePose;
    if (seg.occupancy > 0.05) {
      measured = fitPoseFromMask(seg.bbox, g, W, H, predicted);
      measured.tiltZ = maskTiltZ(seg.mask, W, H);
    } else {
      measured = { ...predicted };
    }

    const localTemp = gpu.mapTemp;
    const localWeight = gpu.mapWeight;
    const yawSearchCenter = this.yawTracker.yaw + this.yawTracker.velYaw * dt;
    const yawResult = trackYaw(this.yawTracker, localTemp, localWeight, yawSearchCenter, dt);
    updateTrack(this.state, measured, yawResult.reliable ? yawResult.yaw : null, seg.occupancy, tSec);

    const canonical = rotateToCanonical(
      { tempK: localTemp, weight: localWeight, yawRef: this.state.pose.yaw },
      this.state.pose.yaw,
    );
    fuseMaps(this.fused, canonical.tempK, canonical.weight, 0.35);
    this.fused.yawRef = this.state.pose.yaw;

    const hotspots = detectHotspots(this.fused, this.detector, this.cfg.alarmThresholdK - 120);
    const frameAlarms = this.alarm.update(this.fused, this.frameCount, tSec, this.cfg, hotspots);
    this.alarms.push(...frameAlarms);

    let frameMax = 0;
    for (const v of this.fused.tempK) if (v > frameMax) frameMax = v;
    if (frameMax > this.maxTempK) {
      this.maxTempK = frameMax;
      const idx = this.fused.tempK.indexOf(frameMax);
      this.maxHotspot = {
        phiDeg: ((idx % MAP_W) / MAP_W) * 360,
        hNorm: (((idx / MAP_W) | 0) + 0.5) / MAP_H,
        tempK: frameMax,
      };
    }

    const result: FrameResult = {
      index: this.frameCount,
      tSec,
      pose: { ...this.state.pose },
      wallMask: seg.mask,
      rejectedHookPixels: seg.rejected,
      occupancy: seg.occupancy,
      unwrap: { tempK: localTemp, weight: localWeight, yawRef: this.state.pose.yaw },
      fused: {
        tempK: Float32Array.from(this.fused.tempK),
        confidence: Float32Array.from(this.fused.confidence),
        maxTempK: Float32Array.from(this.fused.maxTempK),
        yawRef: this.fused.yawRef,
      },
      hotspots: hotspots.map((h) => ({ ...h })),
      alarms: frameAlarms,
      procMs: performance.now() - t0,
    };
    this.frameResults.push(result);
    this.frameCount++;
    return result;
  }

  finalize(startedAt: string) {
    const { maxT, sumT, cnt } = brickStatistics(this.fused);
    const brickStats = [];
    for (let r = 0; r < 12; r++) {
      for (let c = 0; c < 60; c++) {
        const bi = r * 60 + c;
        if (cnt[bi] === 0) continue;
        brickStats.push({
          brickId: `B${r.toString().padStart(2, '0')}-${c.toString().padStart(2, '0')}`,
          col: c,
          row: r,
          maxTempK: maxT[bi],
          meanTempK: sumT[bi] / cnt[bi],
          samples: cnt[bi],
        });
      }
    }
    const record: CampaignRecord = {
      campaignNo: this.header.campaignNo,
      ladleAge: this.header.ladleAge,
      seqId: this.header.seqId,
      ladleId: this.header.ladleId,
      startedAt,
      durationSec: this.header.frameCount / this.header.fps,
      maxTempK: this.maxTempK,
      hotspot: this.maxHotspot,
      brickStats,
      alarms: this.alarms,
    };
    return { frames: this.frameResults, fused: this.fused, alarms: this.alarms, record };
  }
}

function gpuThresholdMask(tempK: Float32Array, W: number, H: number, thresholdK: number): Uint8Array {
  const m = new Uint8Array(W * H);
  for (let i = 0; i < tempK.length; i++) if (tempK[i] >= thresholdK) m[i] = 1;
  return m;
}
