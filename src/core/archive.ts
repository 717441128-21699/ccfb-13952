/**
 * 钢包档案库：按编号建档，持久化每炉次记录
 * 浏览器用 IndexedDB 实现；存储接口抽象出来，Node 测试用内存实现。
 */
import type { CampaignRecord, LadleProfile, WearAdvisory } from './types';
import { BRICK_COLS, BRICK_ROWS } from './types';

export interface ProfileStore {
  load(ladleId: string): Promise<LadleProfile | null>;
  save(profile: LadleProfile): Promise<void>;
  list(): Promise<string[]>;
}

/** 内存存储（测试与降级模式） */
export class MemoryProfileStore implements ProfileStore {
  private map = new Map<string, LadleProfile>();

  async load(ladleId: string): Promise<LadleProfile | null> {
    return this.map.get(ladleId) ?? null;
  }

  async save(profile: LadleProfile): Promise<void> {
    this.map.set(profile.ladleId, profile);
  }

  async list(): Promise<string[]> {
    return [...this.map.keys()];
  }
}

export function createProfile(ladleId: string): LadleProfile {
  return { ladleId, createdAt: new Date().toISOString(), campaigns: [] };
}

/** 追加一炉记录（同 seqId 去重，便于重跑覆盖） */
export function appendCampaign(profile: LadleProfile, rec: CampaignRecord): LadleProfile {
  const idx = profile.campaigns.findIndex((c) => c.seqId === rec.seqId);
  const next: LadleProfile = {
    ...profile,
    campaigns: [...profile.campaigns],
  };
  if (idx >= 0) next.campaigns[idx] = rec;
  else next.campaigns.push(rec);
  next.campaigns.sort((a, b) => a.campaignNo - b.campaignNo);
  return next;
}

export interface BrickHistoryPoint {
  campaignNo: number;
  ladleAge: number;
  maxTempK: number;
  meanTempK: number;
}

/** 取某块砖跨炉次历史 */
export function brickHistory(profile: LadleProfile, col: number, row: number): BrickHistoryPoint[] {
  const id = `B${row.toString().padStart(2, '0')}-${col.toString().padStart(2, '0')}`;
  return profile.campaigns.map((c) => {
    const s = c.brickStats.find((b) => b.brickId === id);
    return {
      campaignNo: c.campaignNo,
      ladleAge: c.ladleAge,
      maxTempK: s?.maxTempK ?? NaN,
      meanTempK: s?.meanTempK ?? NaN,
    };
  }).filter((p) => !Number.isNaN(p.maxTempK));
}

/**
 * 越用越热预警：对每块砖做 maxTemp 随包龄的最小二乘趋势，
 * 外推未来 3 炉，超过换砖温度限即提示。
 */
export function wearAdvisories(profile: LadleProfile, limitK: number): WearAdvisory[] {
  if (profile.campaigns.length < 2) return [];
  const out: WearAdvisory[] = [];
  for (let r = 0; r < BRICK_ROWS; r++) {
    for (let c = 0; c < BRICK_COLS; c++) {
      const hist = brickHistory(profile, c, r);
      if (hist.length < 2) continue;
      const n = hist.length;
      const xs = hist.map((h) => h.ladleAge);
      const ys = hist.map((h) => h.maxTempK);
      const mx = xs.reduce((a, b) => a + b, 0) / n;
      const my = ys.reduce((a, b) => a + b, 0) / n;
      let num = 0;
      let den = 0;
      for (let i = 0; i < n; i++) {
        num += (xs[i] - mx) * (ys[i] - my);
        den += (xs[i] - mx) ** 2;
      }
      if (den < 1e-9) continue;
      const slope = num / den;
      if (slope <= 0) continue;
      const current = ys[n - 1];
      const projected = current + slope * 3;
      if (projected >= limitK || current >= limitK - 40) {
        out.push({
          brickId: `B${r.toString().padStart(2, '0')}-${c.toString().padStart(2, '0')}`,
          col: c,
          row: r,
          currentMaxK: current,
          trendKPerCampaign: slope,
          projectedNext3K: projected,
          limitK,
        });
      }
    }
  }
  return out.sort((a, b) => b.projectedNext3K - a.projectedNext3K);
}
