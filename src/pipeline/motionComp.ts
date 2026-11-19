/**
 * 图像级运动补偿
 *
 * 吊运摆振表现为钢包在画面中的平移与尺度呼吸，会被环向 NCC 误判为自转。
 * 本模块把温度矩阵与掩码从实测位姿 (cx,cy,scale) 逆 warp 到规范位姿
 * (cx0,cy0,scale0)，使后续展开图的环向坐标只反映真实 yaw。
 *
 * 采用逆映射最近邻采样（温度场是量化测量，双线性会把烟尘边缘抹开），
 * 掩码同步 warp 保证补偿后分割约束仍然成立。
 */
import type { LadlePose } from '../core/types';

export interface WarpedFrame {
  tempK: Float32Array;
  mask: Uint8Array;
}

/**
 * @param measured 实测位姿（含摆振平移/尺度）
 * @param target   规范位姿（固定中心/尺度，tilt/yaw 不参与平面 warp）
 */
export function compensateMotion(
  tempK: Float32Array,
  mask: Uint8Array,
  W: number,
  H: number,
  measured: LadlePose,
  target: LadlePose,
  ambientK: number,
): WarpedFrame {
  const outT = new Float32Array(W * H);
  const outM = new Uint8Array(W * H);
  const k = measured.scale / target.scale;

  for (let oy = 0; oy < H; oy++) {
    for (let ox = 0; ox < W; ox++) {
      // 规范像素 -> 实测帧坐标（逆映射）
      const dx = ox - target.cx;
      const dy = oy - target.cy;
      const sx = measured.cx + dx * k;
      const sy = measured.cy + dy * k;
      const ix = Math.round(sx);
      const iy = Math.round(sy);
      const oi = oy * W + ox;
      if (ix < 0 || ix >= W || iy < 0 || iy >= H) {
        outT[oi] = ambientK;
        outM[oi] = 0;
        continue;
      }
      const si = iy * W + ix;
      outT[oi] = tempK[si];
      outM[oi] = mask[si];
    }
  }
  return { tempK: outT, mask: outM };
}
