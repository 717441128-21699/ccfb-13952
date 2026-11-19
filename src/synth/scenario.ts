/** 合成场景配置与预设：按真实钢包几何、吊运运动学和温度场生成红外序列 */
import type { LadleGeometry, OcclusionSpec, SmokePlume, HookSpec } from '../core/types';
import { DEFAULT_GEOMETRY } from '../core/geometry';

export interface MotionSpec {
  /** 自转角速度（度/秒） */
  yawRateDegPerSec: number;
  /** 吊挂摆动幅值（像素） */
  swingPx: number;
  swingFreqHz: number;
  /** 摆动角幅值（度，与平移摆振同频正交） */
  swingAngleDeg: number;
  /** 垂直起伏（像素） */
  bobPx: number;
  bobFreqHz: number;
  /** 水平漂移（像素/秒） */
  driftPxPerSec: number;
  /** 固定俯仰倾角（度） */
  tiltXDeg: number;
  /** 尺度呼吸幅度 */
  scaleBreath: number;
}

export interface HotspotDef {
  phiDeg: number;
  hNorm: number;
  basePeakK: number;
  growthKPerAge: number;
}

export interface ScenarioConfig {
  seqId: string;
  ladleId: string;
  campaignNo: number;
  ladleAge: number;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  geometry: LadleGeometry;
  baseTempK: number;
  emissivityNominal: number;
  ambientK: number;
  smokeTempK: number;
  sensorNoiseSigmaK: number;
  motion: MotionSpec;
  occlusions: OcclusionSpec[];
  smoke: SmokePlume[];
  hook: HookSpec | null;
  hotspotDefs: HotspotDef[];
  seed: number;
  scenario: string;
}

const HOTSPOT_DEFS: HotspotDef[] = [
  { phiDeg: 70, hNorm: 0.55, basePeakK: 320, growthKPerAge: 18 },
  { phiDeg: 215, hNorm: 0.38, basePeakK: 140, growthKPerAge: 9 },
];

function hotspotPeak(d: HotspotDef, age: number): number {
  return d.basePeakK + d.growthKPerAge * (age - 1);
}

export function presetScenarios(): ScenarioConfig[] {
  const common = {
    width: 320,
    height: 240,
    fps: 10,
    geometry: DEFAULT_GEOMETRY,
    baseTempK: 1180,
    emissivityNominal: 0.92,
    ambientK: 320,
    smokeTempK: 470,
    sensorNoiseSigmaK: 1.5,
    hotspotDefs: HOTSPOT_DEFS,
  };

  const swing: MotionSpec = {
    yawRateDegPerSec: 25,
    swingPx: 26,
    swingFreqHz: 0.32,
    swingAngleDeg: 2.5,
    bobPx: 7,
    bobFreqHz: 0.71,
    driftPxPerSec: 1.5,
    tiltXDeg: 4,
    scaleBreath: 0.012,
  };

  const s0: ScenarioConfig = {
    ...common,
    scenario: '定点测温：缓慢转动、弱摆振、轻烟尘（精度标定）',
    seqId: 'SEQ-S0',
    ladleId: 'L-07',
    campaignNo: 127,
    ladleAge: 3,
    durationSec: 45,
    motion: {
      ...swing,
      yawRateDegPerSec: 8,
      swingPx: 8,
      swingFreqHz: 0.25,
      swingAngleDeg: 1.0,
      bobPx: 3,
      driftPxPerSec: 0.4,
    },
    occlusions: [],
    smoke: [
      {
        x0: 0.35, x1: 0.55, y0: 0.5, y1: 0.52, sigmaPx: 38, tauMin: 0.7,
        startSec: 15, endSec: 28, tempK: 460,
      },
    ],
    hook: { startSec: 5, endSec: 40, offsetX: 0.22, offsetY: 0.85, radiusPx: 12, tempK: 750 },
    seed: 55,
  };

  const s1: ScenarioConfig = {
    ...common,
    scenario: '常规吊运：摆振 + 自转 + 单侧烟尘',
    seqId: 'SEQ-S1',
    ladleId: 'L-07',
    campaignNo: 128,
    ladleAge: 4,
    durationSec: 60,
    motion: swing,
    occlusions: [],
    smoke: [
      {
        x0: 0.3, x1: 0.62, y0: 0.45, y1: 0.55, sigmaPx: 46, tauMin: 0.55,
        startSec: 12, endSec: 40, tempK: 470,
      },
    ],
    hook: { startSec: 8, endSec: 55, offsetX: 0.25, offsetY: 0.85, radiusPx: 13, tempK: 760 },
    seed: 101,
  };

  const s2: ScenarioConfig = {
    ...common,
    scenario: '半程遮挡：左半屏硬遮挡 25s，热点不得丢失',
    seqId: 'SEQ-S2',
    ladleId: 'L-07',
    campaignNo: 129,
    ladleAge: 5,
    durationSec: 90,
    motion: { ...swing, yawRateDegPerSec: 32, driftPxPerSec: -1.2 },
    occlusions: [{ startSec: 25, endSec: 50, side: 'left' }],
    smoke: [
      {
        x0: 0.55, x1: 0.25, y0: 0.4, y1: 0.6, sigmaPx: 52, tauMin: 0.45,
        startSec: 15, endSec: 65, tempK: 480,
      },
    ],
    hook: { startSec: 5, endSec: 80, offsetX: -0.3, offsetY: 0.9, radiusPx: 14, tempK: 780 },
    seed: 202,
  };

  const s3: ScenarioConfig = {
    ...common,
    scenario: '长程巡检：连续自转、反复烟尘、热点超阈报警',
    seqId: 'SEQ-S3',
    ladleId: 'L-12',
    campaignNo: 203,
    ladleAge: 7,
    durationSec: 120,
    motion: { ...swing, yawRateDegPerSec: 40, swingPx: 18 },
    occlusions: [
      { startSec: 40, endSec: 52, side: 'right' },
      { startSec: 88, endSec: 98, side: 'left' },
    ],
    smoke: [
      {
        x0: 0.2, x1: 0.7, y0: 0.5, y1: 0.45, sigmaPx: 40, tauMin: 0.5,
        startSec: 10, endSec: 35, tempK: 470,
      },
      {
        x0: 0.8, x1: 0.35, y0: 0.55, y1: 0.5, sigmaPx: 44, tauMin: 0.6,
        startSec: 60, endSec: 95, tempK: 460,
      },
    ],
    hook: { startSec: 0, endSec: 110, offsetX: 0.2, offsetY: 0.8, radiusPx: 12, tempK: 740 },
    seed: 303,
  };

  return [s0, s1, s2, s3];
}

export function scenarioHotspots(cfg: ScenarioConfig) {
  return cfg.hotspotDefs.map((d) => ({
    phiDeg: d.phiDeg,
    hNorm: d.hNorm,
    sigmaPhiDeg: 11,
    sigmaH: 0.09,
    peakK: hotspotPeak(d, cfg.ladleAge),
  }));
}
