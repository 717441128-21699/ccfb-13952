/**
 * 处理 Worker：在后台线程跑 GPU/CPU 管线，主线程零阻塞。
 * 消息协议：
 *   主线程 -> Worker: { type:'init', header, cfg, useGpu } / { type:'frame', index, tempK, tSec }
 *   Worker -> 主线程: { type:'ready' } / { type:'result', frame: FrameResult } / { type:'done', record }
 */
/// <reference lib="webworker" />
import type { PipelineConfig, SequenceHeader } from '../core/types';
import { CpuPipeline, type PipelineRunResult } from '../pipeline/cpuPipeline';

interface InitMsg {
  type: 'init';
  header: SequenceHeader;
  cfg: PipelineConfig;
}
interface FrameMsg {
  type: 'frame';
  index: number;
  tempK: Float32Array;
  tSec: number;
}
type Msg = InitMsg | FrameMsg;

let pipeline: CpuPipeline | null = null;
let header: SequenceHeader | null = null;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (ev: MessageEvent<Msg>) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    header = msg.header;
    // Worker 内优先 GPU，失败由主线程降级为 CPU（此处先接 CPU，GPU 需 OffscreenCanvas 上下文）
    pipeline = new CpuPipeline(header, msg.cfg);
    ctx.postMessage({ type: 'ready' });
    return;
  }
  if (msg.type === 'frame' && pipeline && header) {
    const frame = pipeline.process(msg.tempK, msg.tSec);
    // 仅回传轻量结果，避免结构化拷贝过大
    ctx.postMessage({
      type: 'result',
      index: msg.index,
      frame: {
        ...frame,
        fused: {
          ...frame.fused,
          tempK: frame.fused.tempK,
          confidence: frame.fused.confidence,
          maxTempK: frame.fused.maxTempK,
        },
      },
    });
  }
};

export type { PipelineRunResult };
