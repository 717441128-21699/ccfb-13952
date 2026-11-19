import { describe, expect, it } from 'vitest';
import { AlarmMonitor, createDetector } from '../src/pipeline/hotspots';
import { DEFAULT_CONFIG, type FusedMap } from '../src/core/types';
import { MAP_H, MAP_W } from '../src/core/types';

function makeFused(fillK: number, hotK?: number, hotIdx = 100): FusedMap {
  const tempK = new Float32Array(MAP_W * MAP_H).fill(fillK);
  const confidence = new Float32Array(MAP_W * MAP_H).fill(0.9);
  if (hotK !== undefined) tempK[hotIdx] = hotK;
  return { tempK, confidence, maxTempK: tempK.slice(), yawRef: 0 };
}

describe('3 秒超阈报警状态机', () => {
  it('超阈持续 3 秒才报警，且时延贴近 holdSec', () => {
    const cfg = { ...DEFAULT_CONFIG, alarmThresholdK: 1500, alarmHoldSec: 3 };
    const monitor = new AlarmMonitor();
    const detector = createDetector();
    const fps = 10;
    const events = [];
    for (let f = 0; f < 60; f++) {
      const t = f / fps;
      const fused = f >= 5 ? makeFused(1200, 1580) : makeFused(1200);
      const ev = monitor.update(fused, f, t, cfg, detector.tracked);
      events.push(...ev);
    }
    expect(events.length).toBe(1);
    // 超阈从 t=0.5 开始，报警应在 t≈3.5
    expect(events[0].tSec).toBeGreaterThan(3.4);
    expect(events[0].tSec).toBeLessThan(3.7);
    expect(events[0].latencyMs).toBeGreaterThanOrEqual(2900);
    expect(events[0].latencyMs).toBeLessThan(3200);
  });

  it('短暂超阈（<3s）不报警', () => {
    const cfg = { ...DEFAULT_CONFIG, alarmThresholdK: 1500, alarmHoldSec: 3 };
    const monitor = new AlarmMonitor();
    const detector = createDetector();
    let count = 0;
    for (let f = 0; f < 40; f++) {
      const t = f / 10;
      // 仅 2 秒超阈
      const fused = f >= 10 && f < 30 ? makeFused(1200, 1580) : makeFused(1200);
      count += monitor.update(fused, f, t, cfg, detector.tracked).length;
    }
    expect(count).toBe(0);
  });

  it('超阈中断后重新计时', () => {
    const cfg = { ...DEFAULT_CONFIG, alarmThresholdK: 1500, alarmHoldSec: 3 };
    const monitor = new AlarmMonitor();
    const detector = createDetector();
    let count = 0;
    for (let f = 0; f < 80; f++) {
      const t = f / 10;
      let fused = makeFused(1200);
      if ((f >= 5 && f < 25) || f >= 30) fused = makeFused(1200, 1580);
      count += monitor.update(fused, f, t, cfg, detector.tracked).length;
    }
    expect(count).toBe(1);
  });
});
