/** 领域类型定义 —— 钢包红外热像监测系统 */

export interface Vec2 {
  x: number;
  y: number;
}

/** 钢包外壁几何（米）：回转截锥体 */
export interface LadleGeometry {
  /** 上口外半径 */
  rTop: number;
  /** 下底外半径 */
  rBottom: number;
  /** 外壁高度 */
  height: number;
}

/** 一帧位姿（合成真值与管线估计共用同一结构） */
export interface LadlePose {
  /** 轴线投影中心（像素） */
  cx: number;
  cy: number;
  /** 米 -> 像素 尺度 */
  scale: number;
  /** 绕水平轴倾角（弧度，桶口倾斜） */
  tiltX: number;
  /** 图像面内滚转（弧度） */
  tiltZ: number;
  /** 绕自身竖轴自转（弧度），决定包壁环向相位 */
  yaw: number;
}

/** 硬遮挡（设备/相邻钢包）描述，屏幕半区或环向带 */
export interface OcclusionSpec {
  startSec: number;
  endSec: number;
  /** 'left' | 'right'：遮挡屏幕左/右半区 */
  side: 'left' | 'right';
}

/** 天车钩子（高温干扰源） */
export interface HookSpec {
  startSec: number;
  endSec: number;
  /** 相对桶口中心的位置（米，世界坐标） */
  offsetX: number;
  offsetY: number;
  radiusPx: number;
  tempK: number;
}

/** 烟尘团 */
export interface SmokePlume {
  /** 屏幕空间漂移中心（相对帧宽/高的比例，随时间线性插值） */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  sigmaPx: number;
  /** 最低透过率（0=完全遮蔽） */
  tauMin: number;
  startSec: number;
  endSec: number;
  tempK: number;
}

/** 序列级元信息（.lirs 文件头） */
export interface SequenceHeader {
  magic: 'LIRS1';
  seqId: string;
  ladleId: string;
  campaignNo: number;
  /** 包龄（炉） */
  ladleAge: number;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  emissivityNominal: number;
  ambientK: number;
  geometry: LadleGeometry;
  cameraFovYDeg: number;
  scenario: string;
  createdAt: string;
}

/** 每帧真值（仅合成序列旁路携带，处理管线严禁读取） */
export interface FrameTruth {
  pose: LadlePose;
  /** 被硬遮挡的屏幕半区（无则 null） */
  occludedSide: 'left' | 'right' | null;
  /** 该帧烟尘最低透过率 */
  smokeTauMin: number;
  hook: { x: number; y: number; r: number; tempK: number } | null;
}

export interface FrameRecord {
  index: number;
  tSec: number;
  /** width*height 行优先原始测温矩阵（K） */
  tempK: Float32Array;
  truth?: FrameTruth;
}

/** 展开图尺寸：环向 1° 一列 */
export const MAP_W = 360;
export const MAP_H = 96;
/** 耐材砖格 */
export const BRICK_COLS = 60;
export const BRICK_ROWS = 12;

export interface UnwrapMap {
  /** 观测温度 K（MAP_W*MAP_H，行优先，h 从底到口） */
  tempK: Float32Array;
  /** 置信权重 0..1（可见性 × 透过率） */
  weight: Float32Array;
  /** 本图采用的 yaw 基准（弧度） */
  yawRef: number;
}

export interface FusedMap {
  /** 融合后温度 K */
  tempK: Float32Array;
  /** 累积置信度 */
  confidence: Float32Array;
  /** 历史最高温 K */
  maxTempK: Float32Array;
  yawRef: number;
}

export interface Hotspot {
  id: number;
  phiDeg: number;
  hNorm: number;
  tempK: number;
  brickCol: number;
  brickRow: number;
}

export interface AlarmEvent {
  frameIndex: number;
  tSec: number;
  phiDeg: number;
  hNorm: number;
  tempK: number;
  thresholdK: number;
  /** 超阈时刻 -> 报警时刻的时延（毫秒） */
  latencyMs: number;
  hotspotId: number;
}

export interface BrickStat {
  brickId: string;
  col: number;
  row: number;
  maxTempK: number;
  meanTempK: number;
  samples: number;
}

export interface CampaignRecord {
  campaignNo: number;
  ladleAge: number;
  seqId: string;
  ladleId: string;
  startedAt: string;
  durationSec: number;
  maxTempK: number;
  hotspot: { phiDeg: number; hNorm: number; tempK: number } | null;
  brickStats: BrickStat[];
  alarms: AlarmEvent[];
}

export interface WearAdvisory {
  brickId: string;
  col: number;
  row: number;
  currentMaxK: number;
  trendKPerCampaign: number;
  projectedNext3K: number;
  limitK: number;
}

export interface LadleProfile {
  ladleId: string;
  createdAt: string;
  campaigns: CampaignRecord[];
}

/** 管线每帧产物（UI 与测试用） */
export interface FrameResult {
  index: number;
  tSec: number;
  pose: LadlePose;
  /** 包壁掩码（0/1，帧尺寸） */
  wallMask: Uint8Array;
  /** 被剔除的钩子像素数 */
  rejectedHookPixels: number;
  /** 掩码占用率（相对包络面积） */
  occupancy: number;
  unwrap: UnwrapMap;
  fused: FusedMap;
  hotspots: Hotspot[];
  alarms: AlarmEvent[];
  /** 本帧处理耗时（毫秒） */
  procMs: number;
}

export interface PipelineConfig {
  /** 报警温度阈值（K） */
  alarmThresholdK: number;
  /** 超阈持续多久报警（秒） */
  alarmHoldSec: number;
  /** 分割阈值（K） */
  segmentThresholdK: number;
  /** 名义发射率 */
  emissivityNominal: number;
  ambientK: number;
  /** 烟尘温度 K */
  smokeTempK: number;
  /** 换砖预警温度 K */
  brickReplaceLimitK: number;
}

export const DEFAULT_CONFIG: PipelineConfig = {
  alarmThresholdK: 1550,
  alarmHoldSec: 3,
  segmentThresholdK: 600,
  emissivityNominal: 0.92,
  ambientK: 320,
  smokeTempK: 480,
  brickReplaceLimitK: 1600,
};
