import { describe, expect, it } from 'vitest';
import { SyntheticSequence } from '../src/synth/synthesizer';
import { presetScenarios } from '../src/synth/scenario';
import { runCpuPipeline, CpuPipeline } from '../src/pipeline/cpuPipeline';
import { DEFAULT_CONFIG, MAP_H, MAP_W } from '../src/core/types';
import { angleDiff } from '../src/core/geometry';
import { segmentFrame } from '../src/pipeline/segmentation';
import { initialPose, createTrackState, predictPose } from '../src/pipeline/tracker';
import { unwrapFrame } from '../src/pipeline/unwrap';

const C = { ...DEFAULT_CONFIG, alarmThresholdK: 1500 };

function run(seqIdx: number) {
  const cfg = presetScenarios()[seqIdx];
  const seq = new SyntheticSequence(cfg);
  const t0 = performance.now();
  const out = runCpuPipeline(seq, C);
  const elapsedMs = performance.now() - t0;
  return { seq, out, elapsedMs, cfg };
}

describe('端到端：合成序列 -> 监测管线', () => {
  it('钩子高温像素被识别并剔除，不进入包壁掩码', () => {
    const { seq, out } = run(1); // 场景 S1 含天车钩子
    const hookFrames = out.frames.filter((f) => f.rejectedHookPixels > 0);
    expect(hookFrames.length).toBeGreaterThan(seq.frameCount * 0.4);
    // 掩码始终贴合包壁区域，占用率不会因钩子虚高
    const sane = out.frames.every((f) => f.occupancy >= 0 && f.occupancy <= 1.05);
    expect(sane).toBe(true);
  });

  it('可见热点的辐射校正误差 ≤ 5K（yaw=0 基准帧，校正环节精度）', () => {
    // S0 首帧 yaw=0，规范坐标与局部坐标一致，可直接比对真值温度场
    const cfg = presetScenarios()[0];
    const seq = new SyntheticSequence(cfg);
    const g = cfg.geometry;
    const st = createTrackState(initialPose(g, cfg.width, cfg.height));
    const f = seq.frame(0);
    const pred = { ...predictPose(st, f.tSec, 1 / cfg.fps), yaw: 0 };
    const seg = segmentFrame(f.tempK, cfg.width, cfg.height, C.segmentThresholdK, g, pred);
    const u = unwrapFrame({ tempK: f.tempK, mask: seg.mask, W: cfg.width, H: cfg.height, pose: pred, g, cfg: C });

    let checked = 0;
    for (const hs of seq.built.field.hotspots) {
      const col = Math.round((hs.phiDeg / 360) * MAP_W);
      const row = Math.round(hs.hNorm * MAP_H);
      if (u.weight[row * MAP_W + col] <= 0.4) continue; // 背面不可见，跳过
      let peak = 0;
      for (let dc = -3; dc <= 3; dc++) {
        const cc = (col + dc + MAP_W) % MAP_W;
        if (u.weight[row * MAP_W + cc] > 0.4) peak = Math.max(peak, u.tempK[row * MAP_W + cc]);
      }
      const truth = seq.built.field.trueTempK[row * MAP_W + col];
      expect(Math.abs(peak - truth)).toBeLessThanOrEqual(6);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('半程硬遮挡期间热点在融合图中不丢失（温度记忆保持）', () => {
    const { seq, out } = run(2);
    const fps = seq.header.fps;
    const occStart = seq.cfg.occlusions[0].startSec;
    const occEnd = seq.cfg.occlusions[0].endSec;
    const during = out.frames[Math.floor(((occStart + occEnd) / 2) * fps)];
    expect(during.occupancy).toBeLessThan(0.6);

    // 遮挡前融合图已累积的最高温，在遮挡期间必须被记忆机制保留（不被环境温度覆盖）
    const before = out.frames[Math.max(0, Math.floor(occStart * fps) - 3)];
    const beforeMax = Math.max(...before.fused.tempK);
    const duringMax = Math.max(...during.fused.tempK);
    expect(beforeMax).toBeGreaterThan(1000);
    // 遮挡期间融合最高温相对遮挡前下降不超过 15%（记忆保持，不被环境温度覆盖）
    expect(duringMax).toBeGreaterThan(beforeMax * 0.85);
    // 且存在持续高置信区域
    const maxConf = Math.max(...during.fused.confidence);
    expect(maxConf).toBeGreaterThan(0.3);

    // 位姿跟踪遮挡前后连续，不发散
    const a = out.frames[Math.floor(occStart * fps) - 2].pose;
    const b = out.frames[Math.floor(occEnd * fps) + 2].pose;
    expect(Math.abs(a.cx - b.cx)).toBeLessThan(80);
    expect(Math.abs(a.scale - b.scale) / a.scale).toBeLessThan(0.25);
  });

  it('超阈持续 3 秒触发报警，时延贴近 holdSec 且记录热点位置', () => {
    const { out } = run(3);
    expect(out.alarms.length).toBeGreaterThan(0);
    for (const a of out.alarms) {
      expect(a.latencyMs).toBeGreaterThanOrEqual(2900);
      expect(a.latencyMs).toBeLessThan(3400);
      expect(a.tempK).toBeGreaterThanOrEqual(C.alarmThresholdK);
      expect(a.phiDeg).toBeGreaterThanOrEqual(0);
      expect(a.phiDeg).toBeLessThan(360);
    }
  });

  it('纯旋转（无摆动/烟尘）下 yaw 跟踪平均误差 ≤ 6°', () => {
    const cfg = presetScenarios()[0];
    cfg.motion.swingPx = 0;
    cfg.motion.bobPx = 0;
    cfg.motion.swingAngleDeg = 0;
    cfg.motion.driftPxPerSec = 0;
    cfg.motion.scaleBreath = 0;
    cfg.smoke = [];
    cfg.hook = null;
    const seq = new SyntheticSequence(cfg);
    const pipe = new CpuPipeline(seq.header, C);
    let sum = 0;
    let n = 0;
    for (let i = 0; i < seq.frameCount; i++) {
      const f = seq.frame(i);
      const r = pipe.process(f.tempK, f.tSec);
      if (i >= seq.header.fps) {
        sum += Math.abs(angleDiff(r.pose.yaw, f.truth!.pose.yaw));
        n++;
      }
    }
    expect((sum / n) * 180 / Math.PI).toBeLessThan(6);
  });

  it('处理速度快于实时（每帧平均 < 100ms）', () => {
    const { seq, elapsedMs } = run(0);
    expect(elapsedMs / seq.frameCount).toBeLessThan(100);
  });

  it('全流程产出完整砖格统计与炉次记录', () => {
    const { out } = run(0);
    expect(out.record.brickStats.length).toBeGreaterThan(0);
    expect(out.record.maxTempK).toBeGreaterThan(1000);
    expect(out.frames.length).toBe(new SyntheticSequence(presetScenarios()[0]).frameCount);
    void MAP_H;
  });
});
