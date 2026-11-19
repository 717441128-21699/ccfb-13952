/**
 * .lirs 红外序列容器
 *
 * 布局（小端）：
 *   文件头 96 字节：
 *     magic[5]="LIRS1", u8 pad,
 *     f32 width,height,fps, f32 frameCount,
 *     f32 emissivityNominal, ambientK,
 *     f32 rTop,rBottom,height(几何), fovY,
 *     f32 campaignNo, ladleAge,
 *     u32 idLen, 随后 idLen 字节 "ladleId|seqId|scenario"
 *   每帧：f64 tSec, f32[width*height] 温度矩阵（行优先）
 *
 * 真值不进入 .lirs（管线禁止接触真值），另写 .truth.json 旁路文件仅供测试。
 */
import type { FrameRecord, SequenceHeader, FrameTruth } from '../core/types';
import type { BuiltScenario } from './synthesizer';

const HEADER_FIXED = 64;

export function encodeHeader(h: SequenceHeader, idBlob: string): ArrayBuffer {
  const idBytes = new TextEncoder().encode(idBlob);
  const buf = new ArrayBuffer(HEADER_FIXED + idBytes.length);
  const dv = new DataView(buf);
  const magic = new TextEncoder().encode(h.magic);
  for (let i = 0; i < magic.length; i++) dv.setUint8(i, magic[i]);
  dv.setFloat32(8, h.width, true);
  dv.setFloat32(12, h.height, true);
  dv.setFloat32(16, h.fps, true);
  dv.setFloat32(20, h.frameCount, true);
  dv.setFloat32(24, h.emissivityNominal, true);
  dv.setFloat32(28, h.ambientK, true);
  dv.setFloat32(32, h.geometry.rTop, true);
  dv.setFloat32(36, h.geometry.rBottom, true);
  dv.setFloat32(40, h.geometry.height, true);
  dv.setFloat32(44, h.cameraFovYDeg, true);
  dv.setFloat32(48, h.campaignNo, true);
  dv.setFloat32(52, h.ladleAge, true);
  dv.setUint32(56, idBytes.length, true);
  new Uint8Array(buf, HEADER_FIXED).set(idBytes);
  return buf;
}

export function decodeHeader(buf: ArrayBuffer): { header: SequenceHeader; idBlob: string; headerBytes: number } {
  const dv = new DataView(buf);
  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 5));
  if (magic !== 'LIRS1') throw new Error('非法 .lirs 文件：magic 不匹配');
  const idLen = dv.getUint32(56, true);
  const idBlob = new TextDecoder().decode(new Uint8Array(buf, HEADER_FIXED, idLen));
  const [ladleId, seqId, scenario] = idBlob.split('|');
  const header: SequenceHeader = {
    magic: 'LIRS1',
    seqId,
    ladleId,
    campaignNo: Math.round(dv.getFloat32(48, true)),
    ladleAge: Math.round(dv.getFloat32(52, true)),
    width: dv.getFloat32(8, true),
    height: dv.getFloat32(12, true),
    fps: dv.getFloat32(16, true),
    frameCount: dv.getFloat32(20, true),
    emissivityNominal: dv.getFloat32(24, true),
    ambientK: dv.getFloat32(28, true),
    geometry: {
      rTop: dv.getFloat32(32, true),
      rBottom: dv.getFloat32(36, true),
      height: dv.getFloat32(40, true),
    },
    cameraFovYDeg: dv.getFloat32(44, true),
    scenario,
    createdAt: new Date(0).toISOString(),
  };
  return { header, idBlob, headerBytes: HEADER_FIXED + idLen };
}

/** 流式写出：逐帧追加，避免长序列整驻内存 */
export class LirsWriter {
  private parts: BlobPart[] = [];
  readonly header: SequenceHeader;

  constructor(h: SequenceHeader) {
    this.header = h;
    this.parts.push(encodeHeader(h, `${h.ladleId}|${h.seqId}|${h.scenario}`));
  }

  writeFrame(fr: FrameRecord): void {
    const n = this.header.width * this.header.height;
    if (fr.tempK.length !== n) throw new Error('帧尺寸与文件头不符');
    const meta = new ArrayBuffer(8);
    new DataView(meta).setFloat64(0, fr.tSec, true);
    this.parts.push(meta, fr.tempK.buffer.slice(fr.tempK.byteOffset, fr.tempK.byteOffset + n * 4) as ArrayBuffer);
  }

  toBlob(): Blob {
    return new Blob(this.parts, { type: 'application/octet-stream' });
  }
}

/** 随机读取 .lirs（浏览器 File/Blob 切片 + DataView） */
export class LirsReader {
  readonly header: SequenceHeader;
  private readonly headerBytes: number;
  private readonly frameBytes: number;

  constructor(private blob: Blob, buf: ArrayBuffer) {
    const dec = decodeHeader(buf);
    this.header = dec.header;
    this.headerBytes = dec.headerBytes;
    this.frameBytes = 8 + this.header.width * this.header.height * 4;
  }

  static async open(blob: Blob): Promise<LirsReader> {
    const headBuf = await blob.slice(0, 4096).arrayBuffer();
    return new LirsReader(blob, headBuf);
  }

  async readFrame(index: number): Promise<FrameRecord> {
    const { width, height, frameCount } = this.header;
    if (index < 0 || index >= frameCount) throw new RangeError(`帧 ${index} 越界`);
    const off = this.headerBytes + index * this.frameBytes;
    const chunk = await this.blob.slice(off, off + this.frameBytes).arrayBuffer();
    const dv = new DataView(chunk);
    const tSec = dv.getFloat64(0, true);
    const tempK = new Float32Array(width * height);
    tempK.set(new Float32Array(chunk, 8));
    return { index, tSec, tempK };
  }
}

/** Node/测试用：真值旁路 JSON */
export interface TruthSidecar {
  seqId: string;
  frames: FrameTruth[];
}

export function encodeTruth(built: BuiltScenario, frames: FrameRecord[]): string {
  const data: TruthSidecar = {
    seqId: built.header.seqId,
    frames: frames.map((f) => f.truth as FrameTruth),
  };
  return JSON.stringify(data);
}
