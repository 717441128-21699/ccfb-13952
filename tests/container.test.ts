import { describe, expect, it } from 'vitest';
import { SyntheticSequence } from '../src/synth/synthesizer';
import { presetScenarios } from '../src/synth/scenario';
import { LirsReader, LirsWriter } from '../src/synth/container';

describe('.lirs 容器往返', () => {
  it('写出后随机读回，文件头与帧数据一致', async () => {
    const cfg = presetScenarios()[0];
    const seq = new SyntheticSequence(cfg);
    const writer = new LirsWriter(seq.header);
    for (let i = 0; i < seq.frameCount; i++) writer.writeFrame(seq.frame(i));
    const blob = writer.toBlob();
    expect(blob.size).toBeGreaterThan(0);

    const reader = await LirsReader.open(blob);
    expect(reader.header.seqId).toBe(seq.header.seqId);
    expect(reader.header.frameCount).toBe(seq.frameCount);
    expect(reader.header.width).toBe(seq.header.width);

    const f0 = await reader.readFrame(0);
    const truth0 = seq.frame(0);
    expect(f0.tSec).toBeCloseTo(truth0.tSec, 5);
    expect(f0.tempK.length).toBe(seq.header.width * seq.header.height);
    let maxDiff = 0;
    for (let i = 0; i < f0.tempK.length; i++) maxDiff = Math.max(maxDiff, Math.abs(f0.tempK[i] - truth0.tempK[i]));
    expect(maxDiff).toBeLessThan(1e-4);

    // 随机读取靠后的帧
    const last = await reader.readFrame(seq.frameCount - 1);
    expect(last.tempK.length).toBe(seq.header.width * seq.header.height);
  });
});
