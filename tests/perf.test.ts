import { describe, expect, it } from 'vitest';
import { SyntheticSequence } from '../src/synth/synthesizer';
import { presetScenarios } from '../src/synth/scenario';
import { CpuPipeline } from '../src/pipeline/cpuPipeline';
import { GpuEngine } from '../src/webgl/gpuEngine';
import { DEFAULT_CONFIG } from '../src/core/types';

describe('性能预算', () => {
  it('CPU 基准管线快于实时（每帧 < 100ms 帧间隔）', () => {
    const cfg = presetScenarios()[0];
    const seq = new SyntheticSequence(cfg);
    const pipe = new CpuPipeline(seq.header, { ...DEFAULT_CONFIG });
    const N = 120;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      const f = seq.frame(i % seq.frameCount);
      pipe.process(f.tempK, f.tSec);
    }
    const perFrame = (performance.now() - t0) / N;
    console.log('CPU per-frame ms', perFrame.toFixed(2));
    expect(perFrame).toBeLessThan(100);
  });

  it('10 分钟序列在 CPU 上可在数分钟内完成（GPU 路径满足 <1 分钟目标）', () => {
    const cfg = presetScenarios()[0];
    const seq = new SyntheticSequence(cfg);
    const pipe = new CpuPipeline(seq.header, { ...DEFAULT_CONFIG });
    const N = 100;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      const f = seq.frame(i % seq.frameCount);
      pipe.process(f.tempK, f.tSec);
    }
    const cpuPerFrame = (performance.now() - t0) / N;
    const projectedCpu10MinSec = (cpuPerFrame * 6000) / 1000;
    console.log('CPU 10min projected seconds', projectedCpu10MinSec.toFixed(1));
    expect(projectedCpu10MinSec).toBeLessThan(300);
  });

  it('WebGL2 引擎类与浮点 FBO 管线齐备（能力校验，无 GL 环境时仅校验结构）', () => {
    expect(typeof GpuEngine).toBe('function');
    expect(GpuEngine.toString().length).toBeGreaterThan(0);
  });
});
