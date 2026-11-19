/**
 * CPU 处理管线（算法基准实现）
 *
 * 与 GPU 管线共用同一套数学约定，逐帧输出 FrameResult，供：
 *  - 单元/端到端测试做精度真值比对（±5°C、遮挡不丢热点、3s 报警）
 *  - 无 WebGL2 环境的降级路径
 * 浏览器生产路径走 webgl/ 下的 GPU 实现，公式与本文件逐项对应。
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
import { segmentFrame } from './segmentation';
import {
  createTrackState,
  fitPoseFromMask,
  initialPose,
  predictPose,
  updateTrack,
  type TrackState,
} from './tracker';
import { createYawTracker, trackYaw } from './yawTrack';
import { correctTempK } from '../core/radiation';
import { estimateTauField, fuseMaps, rotateToCanonical, unwrapFrame } from './unwrap';
import { AlarmMonitor, brickStatistics, createDetector, detectHotspots } from './hotspots';

export interface PipelineRunResult {
  frames: FrameResult[];
  fused: FusedMap;
  alarms: AlarmEvent[];
  record: CampaignRecord;
}

export class CpuPipeline {
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

  process(tempK: Float32Array, tSec: number): FrameResult {
    const { width: W, height: H, geometry: g } = this.header;
    const t0 = performance.now();
    const dt = this.frameCount === 0 ? 1 / this.header.fps : tSec - this.state.lastT;
    const predicted: LadlePose = predictPose(this.state, tSec, dt);

    const seg = segmentFrame(tempK, W, H, this.cfg.segmentThresholdK, g, predicted);

    let measured: LadlePose;
    if (seg.occupancy > 0.05) {
      measured = fitPoseFromMask(seg.bbox, g, W, H, predicted, seg.mask);
      // tiltZ 二阶矩法在近对称回转壁上不可靠，真实摆振角很小（≤2.5°），置零更稳
      measured.tiltZ = 0;
    } else {
      measured = { ...predicted };
    }

    // 零 yaw 投影：展开图列 = phiLocal，yaw 信息完整保留。
    // 透过率场与全帧校正温度只算一次，两次展开均走纯几何重采样
    const tauField = estimateTauField({
      tempK, mask: seg.mask, W, H, pose: predicted, g, cfg: this.cfg,
    });
    const correctedFrame = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
      correctedFrame[i] = seg.mask[i]
        ? correctTempK(tempK[i], {
            emissivity: this.cfg.emissivityNominal,
            transmittance: tauField[i],
            ambientK: this.cfg.ambientK,
            smokeTempK: this.cfg.smokeTempK,
          })
        : this.cfg.ambientK;
    }

    // 零 yaw 投影：展开图列 = phiLocal，yaw 信息完整保留。
    const localUnwrap = unwrapFrame({
      tempK, mask: seg.mask, W, H,
      pose: { ...predicted, yaw: 0, tiltX: measured.tiltX, tiltZ: measured.tiltZ },
      g, cfg: this.cfg, tauField, correctedFrame,
    });

    // 搜索中心用 yaw 跟踪器自身的速度预测，窗口拒绝摆动/烟尘伪峰
    const yawSearchCenter = this.yawTracker.yaw + this.yawTracker.velYaw * dt;
    const yawResult = trackYaw(this.yawTracker, localUnwrap.tempK, localUnwrap.weight, yawSearchCenter, dt);
    updateTrack(this.state, measured, yawResult.reliable ? yawResult.yaw : null, seg.occupancy, tSec);

    // 用测得的绝对 yaw 把局部展开图环向旋转到本体规范坐标（纯列拷贝，无重复投影/反演）
    const canonical = rotateToCanonical(localUnwrap, this.state.pose.yaw);
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
        hNorm: ((idx / MAP_W | 0) + 0.5) / MAP_H,
        tempK: frameMax,
      };
    }

    const result: FrameResult = {
      index: this.frameCount,
      tSec,
      pose: { ...this.state.pose },
      wallMask: seg.mask,
      rejectedHookPixels: seg.rejectedHookPixels,
      occupancy: seg.occupancy,
      unwrap: localUnwrap,
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

  finalize(startedAt: string): PipelineRunResult {
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

/** 一次性跑完整个惰性序列（测试/小序列用） */
export function runCpuPipeline(
  seq: { header: SequenceHeader; frameCount: number; frame(i: number): { tempK: Float32Array; tSec: number } },
  cfg: PipelineConfig,
  startedAt = new Date(0).toISOString(),
): PipelineRunResult {
  const pipe = new CpuPipeline(seq.header, cfg);
  for (let i = 0; i < seq.frameCount; i++) {
    const f = seq.frame(i);
    pipe.process(f.tempK, f.tSec);
  }
  return pipe.finalize(startedAt);
}
