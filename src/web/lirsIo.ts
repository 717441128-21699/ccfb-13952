/**
 * .lirs 序列文件的生成与解析演示入口（浏览器侧）。
 * 把内置合成场景编码为 .lirs Blob 以下载，并支持读回校验，验证容器往返一致性。
 */
import { SyntheticSequence } from '../synth/synthesizer';
import { presetScenarios } from '../synth/scenario';
import { LirsReader, LirsWriter, encodeTruth } from '../synth/container';

export function buildScenarioBlob(scenarioIndex: number): {
  blob: Blob;
  filename: string;
  frameCount: number;
  sidecar: string;
} {
  const cfg = presetScenarios()[scenarioIndex];
  const seq = new SyntheticSequence(cfg);
  const writer = new LirsWriter(seq.header);
  const frames = [];
  for (let i = 0; i < seq.frameCount; i++) {
    const frame = seq.frame(i);
    writer.writeFrame(frame);
    frames.push(frame);
  }
  return {
    blob: writer.toBlob(),
    filename: `${seq.header.seqId}.lirs`,
    frameCount: seq.frameCount,
    sidecar: encodeTruth(seq.built, frames),
  };
}

/** 往返自检：写出后用 LirsReader 读回，核对帧数与尺寸 */
export async function roundTripCheck(scenarioIndex: number): Promise<{
  ok: boolean;
  frames: number;
  width: number;
  height: number;
}> {
  const cfg = presetScenarios()[scenarioIndex];
  const seq = new SyntheticSequence(cfg);
  const writer = new LirsWriter(seq.header);
  for (let i = 0; i < seq.frameCount; i++) writer.writeFrame(seq.frame(i));
  const reader = await LirsReader.open(writer.toBlob());
  const first = await reader.readFrame(0);
  return {
    ok:
      reader.header.frameCount === seq.frameCount &&
      first.tempK.length === seq.header.width * seq.header.height,
    frames: reader.header.frameCount,
    width: reader.header.width,
    height: reader.header.height,
  };
}
