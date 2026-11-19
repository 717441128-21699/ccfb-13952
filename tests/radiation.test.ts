import { describe, expect, it } from 'vitest';
import {
  correctTempK,
  estimateTransmittance,
  m4,
  observedTempK,
  invM4,
} from '../src/core/radiation';

describe('辐射域测温修正', () => {
  it('无烟尘、发射率 1 时正反演一致', () => {
    const wall = 1400;
    const obs = observedTempK(wall, {
      emissivity: 1,
      transmittance: 1,
      ambientK: 320,
      smokeTempK: 470,
    });
    expect(Math.abs(obs - wall)).toBeLessThan(1e-6);
    const back = correctTempK(obs, {
      emissivity: 1,
      transmittance: 1,
      ambientK: 320,
      smokeTempK: 470,
    });
    expect(Math.abs(back - wall)).toBeLessThan(1e-6);
  });

  it('烟尘使读数偏低，反演后恢复真实壁温，误差 < 1K', () => {
    const wall = 1450;
    const p = { emissivity: 0.92, transmittance: 0.55, ambientK: 320, smokeTempK: 470 };
    const obs = observedTempK(wall, p);
    expect(obs).toBeLessThan(wall - 30);
    const corrected = correctTempK(obs, p);
    expect(Math.abs(corrected - wall)).toBeLessThan(1);
  });

  it('低发射率反射环境项不可忽略', () => {
    const wall = 1200;
    const obs = observedTempK(wall, {
      emissivity: 0.85,
      transmittance: 1,
      ambientK: 600,
      smokeTempK: 470,
    });
    const corrected = correctTempK(obs, {
      emissivity: 0.85,
      transmittance: 1,
      ambientK: 600,
      smokeTempK: 470,
    });
    expect(Math.abs(corrected - wall)).toBeLessThan(1);
    // 若忽略反射项直接把观测当壁温，偏差应显著
    expect(Math.abs(obs - wall)).toBeGreaterThan(5);
  });

  it('透过率估计：已知干净参照时恢复 tau', () => {
    const wall = 1400;
    const eps = 0.92;
    const ambientK = 320;
    const smokeK = 470;
    const tauTrue = 0.62;
    const cleanObs = observedTempK(wall, { emissivity: eps, transmittance: 1, ambientK, smokeTempK: smokeK });
    const dirtyObs = observedTempK(wall, { emissivity: eps, transmittance: tauTrue, ambientK, smokeTempK: smokeK });
    const tauHat = estimateTransmittance(dirtyObs, cleanObs, eps, ambientK, smokeK);
    expect(Math.abs(tauHat - tauTrue)).toBeLessThan(0.02);
  });

  it('m4/invM4 互为反函数', () => {
    for (const t of [300, 800, 1500, 2500]) {
      expect(Math.abs(invM4(m4(t)) - t)).toBeLessThan(1e-9);
    }
  });
});
