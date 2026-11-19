/** 报表导出：CSV（炉次/砖格/报警）与 JSON 归档 */
import type { CampaignRecord, LadleProfile, WearAdvisory } from './types';

function csvEscape(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function campaignCsv(rec: CampaignRecord): string {
  const rows: string[] = [];
  rows.push('钢包编号,炉次,包龄,序列,开始时间,时长s,最高温K,最高温°C,热点φ°,热点h,热点温K');
  rows.push(
    [
      rec.ladleId, rec.campaignNo, rec.ladleAge, rec.seqId, rec.startedAt, rec.durationSec.toFixed(1),
      rec.maxTempK.toFixed(1), (rec.maxTempK - 273.15).toFixed(1),
      rec.hotspot?.phiDeg.toFixed(1) ?? '', rec.hotspot?.hNorm.toFixed(3) ?? '', rec.hotspot?.tempK.toFixed(1) ?? '',
    ].map(csvEscape).join(','),
  );
  rows.push('');
  rows.push('砖编号,砖列,砖行,最高温K,最高温°C,均温K,均温°C,样本数');
  for (const b of rec.brickStats) {
    rows.push(
      [b.brickId, b.col, b.row, b.maxTempK.toFixed(1), (b.maxTempK - 273.15).toFixed(1),
        b.meanTempK.toFixed(1), (b.meanTempK - 273.15).toFixed(1), b.samples].map(csvEscape).join(','),
    );
  }
  rows.push('');
  rows.push('报警时间s,帧号,φ°,h,温度K,温度°C,阈值K,时延ms,热点id');
  for (const a of rec.alarms) {
    rows.push(
      [a.tSec.toFixed(2), a.frameIndex, a.phiDeg.toFixed(1), a.hNorm.toFixed(3),
        a.tempK.toFixed(1), (a.tempK - 273.15).toFixed(1), a.thresholdK.toFixed(1),
        a.latencyMs.toFixed(0), a.hotspotId].map(csvEscape).join(','),
    );
  }
  // BOM 让 Excel 正确识别 UTF-8 中文
  return '﻿' + rows.join('\n');
}

export function advisoriesCsv(list: WearAdvisory[]): string {
  const rows = ['砖编号,砖列,砖行,当前最高K,当前最高°C,趋势K/炉,3炉外推K,换砖限K'];
  for (const a of list) {
    rows.push(
      [a.brickId, a.col, a.row, a.currentMaxK.toFixed(1), (a.currentMaxK - 273.15).toFixed(1),
        a.trendKPerCampaign.toFixed(2), a.projectedNext3K.toFixed(1), a.limitK.toFixed(1)]
        .map(csvEscape).join(','),
    );
  }
  return '﻿' + rows.join('\n');
}

export function profileJson(profile: LadleProfile, advisories: WearAdvisory[]): string {
  return JSON.stringify({ exportedAt: new Date().toISOString(), profile, wearAdvisories: advisories }, null, 2);
}

export function downloadText(filename: string, text: string, mime = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
