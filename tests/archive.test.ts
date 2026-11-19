import { describe, expect, it } from 'vitest';
import { appendCampaign, createProfile, wearAdvisories, MemoryProfileStore, brickHistory } from '../src/core/archive';
import type { CampaignRecord } from '../src/core/types';

function campaign(age: number, peakK: number, campaignNo: number): CampaignRecord {
  const brickStats = [];
  for (let r = 0; r < 12; r++) {
    for (let c = 0; c < 60; c++) {
      brickStats.push({
        brickId: `B${r.toString().padStart(2, '0')}-${c.toString().padStart(2, '0')}`,
        col: c,
        row: r,
        maxTempK: c === 10 && r === 6 ? peakK : 1100 + r * 5,
        meanTempK: 1050,
        samples: 100,
      });
    }
  }
  return {
    campaignNo,
    ladleAge: age,
    seqId: `SEQ-${campaignNo}`,
    ladleId: 'L-07',
    startedAt: new Date(0).toISOString(),
    durationSec: 60,
    maxTempK: peakK,
    hotspot: { phiDeg: 60, hNorm: 0.5, tempK: peakK },
    brickStats,
    alarms: [],
  };
}
describe('钢包档案与磨损趋势', () => {
  it('按编号建档、逐炉追加、同序列去重', () => {
    let p = createProfile('L-07');
    p = appendCampaign(p, campaign(1, 1300, 100));
    p = appendCampaign(p, campaign(2, 1340, 101));
    expect(p.campaigns.length).toBe(2);
    // 同 seqId 重跑 -> 覆盖而非追加
    p = appendCampaign(p, { ...campaign(2, 1350, 101), seqId: 'SEQ-101' });
    expect(p.campaigns.length).toBe(2);
    expect(p.campaigns[1].maxTempK).toBe(1350);
    // 新炉次 -> 追加
    p = appendCampaign(p, campaign(3, 1400, 102));
    expect(p.campaigns.length).toBe(3);
  });

  it('越用越热的砖格被提前预警，趋势斜率正确', async () => {
    let p = createProfile('L-07');
    const peaks = [1300, 1360, 1430, 1510];
    peaks.forEach((pk, i) => {
      p = appendCampaign(p, campaign(i + 1, pk, 200 + i));
    });
    const advisories = wearAdvisories(p, 1600);
    const target = advisories.find((a) => a.col === 10 && a.row === 6);
    expect(target).toBeDefined();
    // 斜率 ≈ 70K/炉
    expect(target!.trendKPerCampaign).toBeGreaterThan(55);
    expect(target!.projectedNext3K).toBeGreaterThan(1600);

    const hist = brickHistory(p, 10, 6);
    expect(hist.length).toBe(4);
    expect(hist[3].maxTempK).toBe(1510);

    const store = new MemoryProfileStore();
    await store.save(p);
    expect(await store.list()).toEqual(['L-07']);
    const loaded = await store.load('L-07');
    expect(loaded?.campaigns.length).toBe(4);
  });

  it('温度平稳时不产生预警', () => {
    let p = createProfile('L-09');
    [1200, 1205, 1198, 1202].forEach((pk, i) => {
      p = appendCampaign(p, campaign(i + 1, pk, 300 + i));
    });
    expect(wearAdvisories(p, 1600).length).toBe(0);
  });
});
