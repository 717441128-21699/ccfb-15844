import { describe, expect, it } from 'vitest';
import { RECIPES, getRecipe } from '../src/physics/formulas';
import {
  DEFAULT_PARAMS,
  ReferenceFilm,
  VerticalFilm1D,
  drainageThickness,
  drainageTimeScale,
  sigmaOfGamma,
} from '../src/physics/reference';

const basic = getRecipe('basic');

describe('重力排液理论规律', () => {
  it('特征时间 τ = 3μ/(ρgh₀) 的量级符合肥皂膜文献（亚秒到分钟级）', () => {
    const tau = drainageTimeScale(basic, basic.initialThickness);
    // μ=1.1e-3, h₀=1μm -> τ ≈ 0.336s
    expect(tau).toBeGreaterThan(0.05);
    expect(tau).toBeLessThan(30);
  });

  it('Frankel-Mysels 律：h(t)=h₀/sqrt(1+t/τ)，1/h² 对 t 线性', () => {
    const h0 = basic.initialThickness;
    const tau = drainageTimeScale(basic, h0);
    const invSq = (t: number) => (h0 / drainageThickness(basic, h0, t)) ** 2;
    expect(invSq(0)).toBeCloseTo(1, 10);
    expect(invSq(tau)).toBeCloseTo(2, 10);
    expect(invSq(2 * tau)).toBeCloseTo(3, 10);
  });

  it('单格盒子通量公式与解析 ODE 一致（dh/dt = -ρgh³/(3μ·dx)）', () => {
    const recipe = { ...basic, evaporationRate: 0 };
    // 单格盒子：顶零通量、底开放，有限体积格式与集总 ODE 逐式对应
    const film = new VerticalFilm1D(1, recipe, 0.1);
    const dx = film.dx;
    const h0 = recipe.initialThickness;
    const a = (recipe.density * 9.81) / (3 * recipe.viscosity * dx);
    const tauBox = 1 / (2 * a * h0 * h0);
    const total = 5 * tauBox;
    const steps = 8000;
    const dt = total / steps;
    for (let s = 0; s < steps; s++) film.step(dt, recipe);
    const hTheory = 1 / Math.sqrt(1 / (h0 * h0) + 2 * a * film.simTime);
    // 显式欧拉对 h³ 项的积分误差 < 2%
    expect(Math.abs(film.topThickness() - hTheory) / hTheory).toBeLessThan(0.02);
  });

  it('多格垂直膜：顶部变薄、液量向下输送，剖面单调', () => {
    const recipe = { ...basic, evaporationRate: 0 };
    const film = new VerticalFilm1D(40, recipe, 0.5);
    for (let s = 0; s < 500; s++) film.step(0.02, recipe);
    expect(film.topThickness()).toBeLessThan(recipe.initialThickness);
    // 顶部最薄，沿向下方向膜厚不减
    for (let i = 1; i < film.h.length; i++) {
      expect(film.h[i]).toBeGreaterThanOrEqual(film.h[i - 1] - 1e-15);
    }
  });

  it('球面仿真顶部单调变薄、液体向底部输送；极区几何使排液慢于平面解', () => {
    const dims = { nTheta: 16, nPhi: 24 };
    const film = new ReferenceFilm(dims, basic, DEFAULT_PARAMS.radius);
    const params = {
      ...DEFAULT_PARAMS,
      vorticityDiffusion: 0,
      gammaDiffusion: 0,
      baroclinicGain: 0,
      jacobiIterations: 4,
    };
    const h0 = basic.initialThickness;
    const tau = drainageTimeScale(basic, h0);
    let prevTop = film.topThickness();
    for (let s = 0; s < 240; s++) {
      film.step((2.2 * tau) / 240, basic, params);
      expect(film.topThickness()).toBeLessThanOrEqual(prevTop + 1e-15);
      // 底部（南极 Plateau 边界）始终比顶部厚——液体持续向下输送
      expect(film.bottomThickness()).toBeGreaterThan(film.topThickness());
      prevTop = film.topThickness();
    }
    expect(film.topThickness()).toBeLessThan(h0);
    // 球顶变薄量与 Frankel-Mysels 解析律同量级（极区 sinθ→0 几何使其慢于平面解，
    // 这里只验证物理时间尺度一致：解析解在 2.2τ 时约为 0.56h₀，球面取 0.55h₀~0.999h₀ 区间）
    const hTheory = drainageThickness(basic, h0, 2.2 * tau);
    expect(film.topThickness()).toBeGreaterThan(hTheory);
    expect(film.topThickness()).toBeLessThan(h0);
  });

  it('四种配方的排液速度排序：黏度越高排液越慢', () => {
    const taus = RECIPES.map((r) => drainageTimeScale(r, r.initialThickness));
    for (let i = 1; i < taus.length; i++) {
      expect(taus[i]).toBeGreaterThan(taus[i - 1]);
    }
  });

  it('无蒸发时质量守恒（容差 2%）', () => {
    const dims = { nTheta: 12, nPhi: 16 };
    const recipe = { ...basic, evaporationRate: 0 };
    const film = new ReferenceFilm(dims, recipe, DEFAULT_PARAMS.radius);
    const params = { ...DEFAULT_PARAMS, baroclinicGain: 0, jacobiIterations: 4 };
    const v0 = film.totalFilmVolume();
    for (let s = 0; s < 120; s++) film.step(0.05, recipe, params);
    const v1 = film.totalFilmVolume();
    expect(Math.abs(v1 - v0) / v0).toBeLessThan(0.02);
  });

  it('表面张力随表面活性剂浓度变化：Γ 低处 σ 高（Marangoni 应力来源）', () => {
    const sLow = sigmaOfGamma(basic, 0.2);
    const sHigh = sigmaOfGamma(basic, 0.8);
    expect(sLow).toBeGreaterThan(sHigh);
    expect(sLow - sHigh).toBeCloseTo(basic.surfaceElasticity * 0.6, 1e-12);
  });

  it('非均匀表面活性剂产生涡量（无 NaN），且黑膜占比统计随减薄上升', () => {
    const dims = { nTheta: 12, nPhi: 24 };
    const film = new ReferenceFilm(dims, basic, DEFAULT_PARAMS.radius);
    for (let j = 0; j < dims.nTheta; j++) {
      for (let k = 0; k < dims.nPhi; k++) {
        film.gamma[j * dims.nPhi + k] = 0.5 + 0.4 * Math.sin((k / dims.nPhi) * Math.PI * 2);
      }
    }
    const params = { ...DEFAULT_PARAMS, jacobiIterations: 6 };
    let maxOmega = 0;
    for (let s = 0; s < 60; s++) {
      film.step(0.05, basic, params);
      for (const v of film.omega) {
        expect(Number.isNaN(v)).toBe(false);
        maxOmega = Math.max(maxOmega, Math.abs(v));
      }
    }
    expect(maxOmega).toBeGreaterThan(0);
    for (let k = 0; k < dims.nPhi; k++) film.h[k] = basic.hBlack * 0.5;
    film.step(1e-6, basic, params);
    expect(film.blackFraction).toBeGreaterThan(0);
  });
});
