/**
 * 应用主控：串联合成/导入 -> 处理管线 -> 档案 -> 报表，并驱动 UI。
 * 设计为可在无 Worker 时直接用 CpuPipeline 降级，保证功能完整可演示。
 */
import { SyntheticSequence } from '../synth/synthesizer';
import { presetScenarios } from '../synth/scenario';
import { CpuPipeline, runCpuPipeline } from '../pipeline/cpuPipeline';
import { DEFAULT_CONFIG, type CampaignRecord, type FrameResult, type PipelineConfig, type SequenceHeader } from '../core/types';
import { appendCampaign, createProfile, MemoryProfileStore, wearAdvisories, type ProfileStore } from '../core/archive';
import { IndexedDbProfileStore } from './idbStore';
import { advisoriesCsv, campaignCsv, downloadText, profileJson } from '../core/report';
import { renderFrame, renderUnwrapped, kToC } from './heatmap';

export class LadleMonitorApp {
  private store: ProfileStore;
  private cfg: PipelineConfig = { ...DEFAULT_CONFIG, alarmThresholdK: 1500 };
  private currentFrames: FrameResult[] = [];
  private currentRecord: CampaignRecord | null = null;
  private currentHeader: SequenceHeader | null = null;
  private currentSeq: SyntheticSequence | null = null;
  private compareRecord: CampaignRecord | null = null;

  constructor() {
    this.store = typeof indexedDB !== 'undefined' ? new IndexedDbProfileStore() : new MemoryProfileStore();
  }

  getConfig(): PipelineConfig {
    return { ...this.cfg };
  }

  setConfig(patch: Partial<PipelineConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
  }

  /** 生成并处理一个内置合成场景 */
  async runScenario(index: number, onProgress?: (pct: number, frame: FrameResult) => void): Promise<CampaignRecord> {
    const scenarioCfg = presetScenarios()[index];
    const seq = new SyntheticSequence(scenarioCfg);
    this.currentSeq = seq;
    this.currentHeader = seq.header;
    const pipe = new CpuPipeline(seq.header, this.cfg);
    this.currentFrames = [];
    for (let i = 0; i < seq.frameCount; i++) {
      const f = seq.frame(i);
      const frame = pipe.process(f.tempK, f.tSec);
      this.currentFrames.push(frame);
      onProgress?.((i + 1) / seq.frameCount, frame);
      // 让出主线程，避免长序列卡死 UI
      if (i % 20 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    const result = pipe.finalize(new Date().toISOString());
    this.currentRecord = result.record;
    await this.persistRecord(result.record);
    return result.record;
  }

  private async persistRecord(rec: CampaignRecord): Promise<void> {
    const profile = (await this.store.load(rec.ladleId)) ?? createProfile(rec.ladleId);
    const next = appendCampaign(profile, rec);
    await this.store.save(next);
  }

  getFrames(): FrameResult[] {
    return this.currentFrames;
  }

  getHeader(): SequenceHeader | null {
    return this.currentHeader;
  }

  /** 渲染某帧的原始热图与展开图 */
  renderFrameAt(index: number, frameCanvas: HTMLCanvasElement, mapCanvas: HTMLCanvasElement): void {
    const frame = this.currentFrames[index];
    const seq = this.currentSeq;
    if (!frame || !seq || !this.currentHeader) return;
    const raw = seq.frame(index);
    const range = { minK: this.cfg.ambientK, maxK: this.cfg.alarmThresholdK + 150 };
    renderFrame(frameCanvas, raw.tempK, this.currentHeader.width, this.currentHeader.height, range, frame.wallMask);
    renderUnwrapped(mapCanvas, frame.fused.tempK, frame.fused.confidence, range);
  }

  /** 导出当前炉次报表 */
  exportCampaignCsv(): void {
    if (!this.currentRecord) return;
    downloadText(`${this.currentRecord.seqId}-report.csv`, campaignCsv(this.currentRecord), 'text/csv;charset=utf-8');
  }

  /** 加载钢包档案并计算磨损预警 */
  async loadProfile(ladleId: string) {
    const profile = await this.store.load(ladleId);
    if (!profile) return null;
    const advisories = wearAdvisories(profile, this.cfg.brickReplaceLimitK);
    return { profile, advisories };
  }

  exportProfileJson(ladleId: string): void {
    void this.loadProfile(ladleId).then((loaded) => {
      if (!loaded) return;
      downloadText(`${ladleId}-profile.json`, profileJson(loaded.profile, loaded.advisories), 'application/json');
    });
  }

  exportAdvisoriesCsv(ladleId: string): void {
    void this.loadProfile(ladleId).then((loaded) => {
      if (!loaded) return;
      downloadText(`${ladleId}-wear-advisories.csv`, advisoriesCsv(loaded.advisories), 'text/csv;charset=utf-8');
    });
  }

  /** 选择另一炉次用于展开图对比（拖动滑块联动） */
  async selectForCompare(ladleId: string, seqId: string): Promise<boolean> {
    const profile = await this.store.load(ladleId);
    const rec = profile?.campaigns.find((c) => c.seqId === seqId) ?? null;
    this.compareRecord = rec;
    return rec !== null;
  }

  getCompareRecord(): CampaignRecord | null {
    return this.compareRecord;
  }

  /** 供 UI 显示的实时指标（摄氏度） */
  static toCelsius(k: number): number {
    return kToC(k);
  }

  /** 无 Worker 时的便捷一次性入口（测试/导入 .lirs 复用） */
  runSequence(seq: SyntheticSequence): CampaignRecord {
    const result = runCpuPipeline(seq, this.cfg);
    this.currentFrames = result.frames;
    this.currentRecord = result.record;
    this.currentHeader = seq.header;
    this.currentSeq = seq;
    void this.persistRecord(result.record);
    return result.record;
  }
}
