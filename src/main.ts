import './styles.css';
import { LadleMonitorApp } from './web/app';
import { presetScenarios } from './synth/scenario';
import type { FrameResult } from './core/types';

const app = new LadleMonitorApp();

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const scenarioButtons = $('scenario-buttons');
const runBtn = $('run') as HTMLButtonElement;
const progress = $('progress') as HTMLDivElement;
const slider = $('frame-slider') as HTMLInputElement;
const frameCanvas = $('frame-canvas') as HTMLCanvasElement;
const mapCanvas = $('map-canvas') as HTMLCanvasElement;
const metrics = $('metrics');
const alarmList = $('alarm-list');
const advisoryList = $('advisory-list');
const profileInfo = $('profile-info');
const compareSelect = $('compare-select') as HTMLSelectElement;
const exportCsvBtn = $('export-csv') as HTMLButtonElement;
const exportJsonBtn = $('export-json') as HTMLButtonElement;
const exportAdvBtn = $('export-adv') as HTMLButtonElement;

let selectedScenario = 0;
let frames: FrameResult[] = [];
let currentLadle = '';

presetScenarios().forEach((s, i) => {
  const btn = document.createElement('button');
  btn.textContent = `场景 ${i}：${s.scenario.split('：')[0]}`;
  btn.className = i === 0 ? 'scenario active' : 'scenario';
  btn.onclick = () => {
    selectedScenario = i;
    document.querySelectorAll('.scenario').forEach((el) => el.classList.remove('active'));
    btn.classList.add('active');
  };
  scenarioButtons.appendChild(btn);
});

function renderFrame(index: number): void {
  if (!frames.length) return;
  app.renderFrameAt(index, frameCanvas, mapCanvas);
  const f = frames[index];
  const maxK = Math.max(...f.fused.tempK);
  metrics.innerHTML = `
    <div><span>帧</span><b>${index + 1}/${frames.length}</b></div>
    <div><span>时间</span><b>${f.tSec.toFixed(1)} s</b></div>
    <div><span>掩码占用</span><b>${(f.occupancy * 100).toFixed(0)}%</b></div>
    <div><span>剔除钩子像素</span><b>${f.rejectedHookPixels}</b></div>
    <div><span>融合最高温</span><b class="${maxK >= 1500 ? 'hot' : ''}">${maxK.toFixed(1)} K / ${LadleMonitorApp.toCelsius(maxK).toFixed(1)} ℃</b></div>
    <div><span>热点数</span><b>${f.hotspots.length}</b></div>`;
}

slider.addEventListener('input', () => renderFrame(Number(slider.value)));

runBtn.onclick = async () => {
  runBtn.disabled = true;
  progress.style.width = '0%';
  const record = await app.runScenario(selectedScenario, (pct, frame) => {
    progress.style.width = `${(pct * 100).toFixed(1)}%`;
    void frame;
  });
  frames = app.getFrames();
  currentLadle = record.ladleId;
  slider.max = String(frames.length - 1);
  slider.value = '0';
  renderFrame(0);
  alarmList.innerHTML = record.alarms
    .map((a) => `<li class="alarm">⚠ t=${a.tSec.toFixed(1)}s φ=${a.phiDeg.toFixed(0)}° ${a.tempK.toFixed(0)}K（时延 ${a.latencyMs}ms）</li>`)
    .join('') || '<li class="muted">无报警</li>';
  profileInfo.innerHTML = `钢包 <b>${record.ladleId}</b>｜炉次 ${record.campaignNo}｜包龄 ${record.ladleAge}｜砖格记录 ${record.brickStats.length} 条`;
  await refreshProfile();
  runBtn.disabled = false;
};

async function refreshProfile(): Promise<void> {
  const loaded = await app.loadProfile(currentLadle);
  if (!loaded) return;
  advisoryList.innerHTML = loaded.advisories
    .slice(0, 12)
    .map((a) => `<li>砖 ${a.brickId}：当前 ${a.currentMaxK.toFixed(0)}K，趋势 +${a.trendKPerCampaign.toFixed(1)}K/炉，3 炉外推 ${a.projectedNext3K.toFixed(0)}K</li>`)
    .join('') || '<li class="muted">暂无换砖预警（温度趋势平稳）</li>';
  compareSelect.innerHTML =
    '<option value="">— 选择对比炉次 —</option>' +
    loaded.profile.campaigns.map((c) => `<option value="${c.seqId}">${c.seqId}（炉次 ${c.campaignNo}）</option>`).join('');
}

compareSelect.onchange = async () => {
  const seqId = compareSelect.value;
  if (seqId) await app.selectForCompare(currentLadle, seqId);
};

exportCsvBtn.onclick = () => app.exportCampaignCsv();
exportJsonBtn.onclick = () => app.exportProfileJson(currentLadle);
exportAdvBtn.onclick = () => app.exportAdvisoriesCsv(currentLadle);
