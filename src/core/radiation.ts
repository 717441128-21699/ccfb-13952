/**
 * 辐射测温修正模型
 *
 * 相机像元接收到的辐照度（与 T^4 成正比，公共因子 σ 已吸收到系数中）：
 *
 *   M_meas = τ · ε · M(T_wall)
 *          + τ · (1-ε) · M(T_refl)      // 壁面反射环境
 *          + (1-τ) · M(T_smoke)         // 烟尘自身发射
 *
 * 其中 M(T)=T^4（窄带近似下幂次可调，红外波段常用 4 次方形式），
 * T_refl 取环境温度。反演壁面真实温度：
 *
 *   M(T_wall) = ( M_meas - τ(1-ε)M(T_refl) - (1-τ)M(T_smoke) ) / (τ·ε)
 *
 * 全部在辐射域运算，避免低温段温度域线性修正带来的系统性偏差。
 */

const T_MIN = 250;
const T_MAX = 3500;

export function m4(tK: number): number {
  return tK * tK * tK * tK;
}

export function invM4(m: number): number {
  if (m <= 0) return T_MIN;
  return Math.min(T_MAX, Math.pow(m, 0.25));
}

export interface CorrectionParams {
  emissivity: number;
  transmittance: number;
  ambientK: number;
  smokeTempK: number;
}

/** 正向：真实壁温 + 烟尘 -> 相机测得亮度温度 */
export function observedTempK(trueWallK: number, p: CorrectionParams): number {
  const eps = clamp01(p.emissivity);
  const tau = clamp01(p.transmittance);
  const mWall = m4(trueWallK);
  const mAmb = m4(p.ambientK);
  const mSmk = m4(p.smokeTempK);
  const mMeas = tau * (eps * mWall + (1 - eps) * mAmb) + (1 - tau) * mSmk;
  return invM4(mMeas);
}

/** 逆向：相机亮度温度 + 发射率/透过率 -> 壁面真实温度 */
export function correctTempK(observedK: number, p: CorrectionParams): number {
  const eps = Math.max(1e-3, clamp01(p.emissivity));
  const tau = Math.max(1e-3, clamp01(p.transmittance));
  const mMeas = m4(observedK);
  const mAmb = m4(p.ambientK);
  const mSmk = m4(p.smokeTempK);
  const mWall = (mMeas - tau * (1 - eps) * mAmb - (1 - tau) * mSmk) / (tau * eps);
  return invM4(mWall);
}

/**
 * 由相邻干净参照区估计烟尘透过率。
 * 干净参照（tau=1）与受污染区的壁面真实温度假设接近，
 * 在辐射域解一元一次方程得 τ。返回 [0,1]。
 */
export function estimateTransmittance(
  observedK: number,
  cleanReferenceK: number,
  _emissivity: number,
  _ambientK: number,
  smokeTempK: number,
): number {
  const mMeas = m4(observedK);
  const mCleanEff = m4(cleanReferenceK); // 干净参照的观测辐射，已含壁面反射项
  const mSmk = m4(smokeTempK);
  // 干净参照（tau=1）的有效辐射 M_cleanEff；受污染区 M_meas = τ·M_cleanEff + (1-τ)·M_smk
  const a = mCleanEff - mSmk;
  if (Math.abs(a) < 1e-6) return 1;
  const tau = (mMeas - mSmk) / a;
  return clamp01(tau);
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
