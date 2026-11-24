/**
 * 膜厚流动的参考实现（纯 TypeScript）。
 *
 * 球面等距经纬网格上的润滑理论（lubillation theory）有限体积求解：
 *
 *   ∂h/∂t = -∇·q - E
 *   q = ρ g sinθ h³/(3μ) eθ  +  h²/(2μ) ∇σ          （重力排液 + Marangoni 流）
 *
 * 其中 σ(Γ) = σ₀ + E_s(Γ_ref - Γ)，Γ 为归一化表面活性剂浓度。
 * 涡量 ω 由表面张力经向梯度的斜压项注入，半拉格朗日平流 + 扩散，
 * 再由流函数 ∇²ψ = -ω 的雅可比迭代恢复无散旋涡速度。
 *
 * WGSL 计算着色器中的数学与本文件逐式对应，单元测试只跑本参考实现。
 */
import { GRAVITY, type SoapRecipe } from './formulas';

export interface GridDims {
  /** 纬度方向单元数（北极到南极） */
  nTheta: number;
  /** 经度方向单元数（绕一圈） */
  nPhi: number;
}

export interface SimParams {
  /** 泡泡半径 m */
  radius: number;
  /** 时间加速倍率 */
  timeScale: number;
  /** 涡量扩散系数 m²/s（网格尺度等效值） */
  vorticityDiffusion: number;
  /** 表面活性剂扩散系数 m²/s */
  gammaDiffusion: number;
  /** 流函数雅可比迭代次数 */
  jacobiIterations: number;
  /** 涡量斜压注入系数 */
  baroclinicGain: number;
}

export const DEFAULT_PARAMS: SimParams = {
  radius: 0.25,
  timeScale: 45,
  // 显式扩散需满足 CFL：D·dt/dx² ≤ 0.25。
  // 表面活性剂表面扩散的物理值 ~1e-12 m²/s；涡量为网格尺度等效涡黏。
  vorticityDiffusion: 4.0e-8,
  gammaDiffusion: 1.0e-12,
  jacobiIterations: 10,
  baroclinicGain: 6.0,
};

export function sigmaOfGamma(recipe: SoapRecipe, gammaNorm: number): number {
  // Γ 归一化到 0..1，参考态 Γ_ref = 0.5
  return recipe.surfaceTension + recipe.surfaceElasticity * (0.5 - gammaNorm);
}

/** 重力排液的特征时间 τ = 3μ/(ρ g h₀)，稳态膜厚 h* = sqrt(3μ Q/(ρg sinθ·w)) 等均由此导出 */
export function drainageTimeScale(recipe: SoapRecipe, h0: number): number {
  return (3 * recipe.viscosity) / (recipe.density * GRAVITY * h0);
}

/**
 * 垂直膜经典排液解（稳态、宽度恒定、底部流出通量 Q）：
 * 顶部膜厚随时间满足 h_top(t) = h₀ / sqrt(1 + t/τ)（Frankel-Mysels 律）。
 */
export function drainageThickness(recipe: SoapRecipe, h0: number, t: number): number {
  const tau = drainageTimeScale(recipe, h0);
  return h0 / Math.sqrt(1 + t / tau);
}

interface FaceFlux {
  qTheta: number;
  qPhi: number;
}

/**
 * 一维垂直膜排液模型（Frankel-Mysels 几何）。
 *
 * 竖直悬挂、宽度 w 恒定的膜，只沿向下方向 x 排液，
 * dh/dt = -∂q/∂x - E，q = ρg h³/(3μ) + h²/(2μ) ∂σ/∂x。
 * 顶部边界零通量。该模型顶部膜厚的自相似解即 h = h₀/sqrt(1+t/τ)，
 * 用来对球面仿真做理论标定（球面极区因 sinθ→0 会额外变慢，属几何效应）。
 */
export class VerticalFilm1D {
  h: Float64Array;
  gamma: Float64Array;
  simTime = 0;
  /** 单元高度 m */
  readonly dx: number;
  private readonly length: number;

  constructor(nCells: number, recipe: SoapRecipe, length: number) {
    this.length = length;
    this.dx = length / nCells;
    this.h = new Float64Array(nCells);
    this.gamma = new Float64Array(nCells);
    this.h.fill(recipe.initialThickness);
    this.gamma.fill(0.5);
  }

  step(dt: number, recipe: SoapRecipe): void {
    const n = this.h.length;
    const mu = recipe.viscosity;
    const grav = recipe.density * GRAVITY;
    // 自适应子步：重力通量 CFL，u = ρgh²/(3μ)，要求 dt·u/dx ≤ 0.25
    let hMax = 1e-12;
    for (const v of this.h) hMax = Math.max(hMax, v);
    const uMax = (grav * hMax * hMax) / (3 * mu);
    const dtStable = (0.25 * this.dx) / Math.max(1e-12, uMax);
    const nSub = Math.min(8192, Math.max(1, Math.ceil(dt / dtStable)));
    const subDt = dt / nSub;
    for (let sub = 0; sub < nSub; sub++) {
      const hNew = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const hUp = i === 0 ? this.h[i] : 0.5 * (this.h[i] + this.h[i - 1]);
        // 底部开放边界：液体自由流出，取本格 h，通量不被反射
        const hDown = i === n - 1 ? this.h[i] : 0.5 * (this.h[i] + this.h[i + 1]);
        const dSdxUp =
          i === 0
            ? 0
            : (sigmaOfGamma(recipe, this.gamma[i]) - sigmaOfGamma(recipe, this.gamma[i - 1])) / this.dx;
        const dSdxDown = i === n - 1 ? 0 : (sigmaOfGamma(recipe, this.gamma[i + 1]) - sigmaOfGamma(recipe, this.gamma[i])) / this.dx;
        // 顶部固壁：零通量边界（排液从顶端开始变薄，前缘向下传播）
        const qUp =
          i === 0
            ? 0
            : (grav * hUp ** 3) / (3 * mu) + (hUp ** 2 / (2 * mu)) * dSdxUp;
        const qDown = (grav * hDown ** 3) / (3 * mu) + (hDown ** 2 / (2 * mu)) * dSdxDown;
        let h = this.h[i] - (subDt / this.dx) * (qDown - qUp) - recipe.evaporationRate * subDt;
        if (!Number.isFinite(h)) h = this.h[i];
        hNew[i] = Math.max(recipe.hBlack * 0.1, Math.min(25 * recipe.initialThickness, h));
      }
      this.h = hNew;
    }
    this.simTime += dt;
  }

  topThickness(): number {
    return this.h[0];
  }

  get filmLength(): number {
    return this.length;
  }
}

/** 单元面上的体积通量密度（单位周向长度），m²/s */
export function faceFlux(
  hFace: number,
  thetaFace: number,
  dSigmaDtheta: number,
  dSigmaDphi: number,
  r: number,
  recipe: SoapRecipe,
): FaceFlux {
  const mu = recipe.viscosity;
  const grav = recipe.density * GRAVITY;
  const h2 = hFace * hFace;
  const h3 = h2 * hFace;
  const qTheta = (grav * Math.sin(thetaFace) * h3) / (3 * mu) + (h2 / (2 * mu * r)) * dSigmaDtheta;
  const qPhi = (h2 / (2 * mu * r * Math.sin(thetaFace))) * dSigmaDphi;
  return { qTheta, qPhi };
}

/** 半拉格朗日回采样（经纬坐标空间，经度周期回绕、纬度钳制） */
function sampleField(
  field: Float64Array,
  dims: GridDims,
  theta: number,
  phi: number,
): number {
  const { nTheta, nPhi } = dims;
  const dTheta = Math.PI / nTheta;
  const dPhi = (2 * Math.PI) / nPhi;
  const fj = Math.min(nTheta - 1, Math.max(0, (theta - dTheta / 2) / dTheta));
  let fk = (phi - dPhi / 2) / dPhi;
  fk = ((fk % nPhi) + nPhi) % nPhi;
  const j0 = Math.floor(fj);
  const k0 = Math.floor(fk) % nPhi;
  const tj = fj - j0;
  const tk = fk - Math.floor(fk);
  const j1 = Math.min(nTheta - 1, j0 + 1);
  const k1 = (k0 + 1) % nPhi;
  const a = field[j0 * nPhi + k0];
  const b = field[j0 * nPhi + k1];
  const c = field[j1 * nPhi + k0];
  const d = field[j1 * nPhi + k1];
  return (a * (1 - tk) + b * tk) * (1 - tj) + (c * (1 - tk) + d * tk) * tj;
}

export class ReferenceFilm {
  readonly dims: GridDims;
  h: Float64Array;
  gamma: Float64Array;
  omega: Float64Array;
  psi: Float64Array;
  /** 累计仿真时间 s（已乘加速倍率前的物理时间由外部传入 dt） */
  simTime = 0;
  blackFraction = 0;

  constructor(dims: GridDims, recipe: SoapRecipe, radius: number) {
    this.dims = dims;
    const n = dims.nTheta * dims.nPhi;
    this.h = new Float64Array(n);
    this.gamma = new Float64Array(n);
    this.omega = new Float64Array(n);
    this.psi = new Float64Array(n);
    this.h.fill(recipe.initialThickness);
    this.gamma.fill(0.5);
    void radius;
  }

  private idx(j: number, k: number): number {
    return j * this.dims.nPhi + ((k + this.dims.nPhi) % this.dims.nPhi);
  }

  /**
   * 推进一个物理时间步 dt（秒，已含时间加速）。
   * 内部按"每子步膜厚相对变化 ≤ 5%"自适应拆步——薄膜方程 h³ 迁移率刚性很强，
   * 纯速度 CFL 不足以稳定，相对变化判据保证显式格式有界。
   * 返回本步膜厚总量变化（质量守恒检查用）。
   */
  step(dt: number, recipe: SoapRecipe, p: SimParams): number {
    const h0mass = this.totalFilmVolume();
    let remaining = dt;
    let guard = 0;
    while (remaining > 0 && guard < 8192) {
      guard++;
      const subDt = Math.min(remaining, this.stableDt(recipe, p));
      this.advectVorticityAndGamma(subDt, recipe, p);
      this.solveStreamFunction(subDt, recipe, p);
      this.updateThickness(subDt, recipe, p);
      this.simTime += subDt;
      remaining -= subDt;
    }

    // 黑膜占比统计
    let black = 0;
    for (let i = 0; i < this.h.length; i++) {
      if (this.h[i] < recipe.hBlack) black++;
    }
    this.blackFraction = black / this.h.length;
    return this.totalFilmVolume() - h0mass + recipe.evaporationRate * dt * this.areaSum(p.radius);
  }

  /** 由当前场估算满足相对变化 ≤5%、扩散 CFL 与对流 CFL 的最大稳定步长 */
  private stableDt(recipe: SoapRecipe, p: SimParams): number {
    const { nTheta, nPhi } = this.dims;
    const r = p.radius;
    const dTheta = Math.PI / nTheta;
    const dPhi = (2 * Math.PI) / nPhi;
    const mu = recipe.viscosity;
    const grav = recipe.density * GRAVITY;
    const sinFloor = Math.sin(dTheta / 2);
    let dtRel = Infinity;
    let hMax = 1e-12;
    let gradSigmaMax = 1e-12;
    for (let j = 0; j < nTheta; j++) {
      const thetaC = (j + 0.5) * dTheta;
      const sinC = Math.max(Math.sin(thetaC), sinFloor);
      const area = r * r * sinC * dTheta * dPhi;
      for (let k = 0; k < nPhi; k++) {
        const i = this.idx(j, k);
        hMax = Math.max(hMax, this.h[i]);
        const gT = Math.abs(
          sigmaOfGamma(recipe, this.gamma[i]) -
            sigmaOfGamma(recipe, this.gamma[this.idx(Math.max(0, j - 1), k)]),
        ) / dTheta;
        const gP = Math.abs(
          sigmaOfGamma(recipe, this.gamma[this.idx(j, k + 1)]) -
            sigmaOfGamma(recipe, this.gamma[i]),
        ) / dPhi;
        gradSigmaMax = Math.max(gradSigmaMax, gT, gP);
        // 该单元四面通量的保守上界（绝对值和）
        const hh = this.h[i];
        const qBound =
          area * ((grav * hh * hh) / (3 * mu) + (hh * gradSigmaMax) / (2 * mu)) * 4;
        const denom = Math.abs(qBound) / area + recipe.evaporationRate + 1e-30;
        dtRel = Math.min(dtRel, (0.05 * Math.max(hh, recipe.hBlack)) / denom);
      }
    }
    const dxMin = r * dTheta;
    const uMax = (grav * hMax * hMax) / (3 * mu) + (hMax * gradSigmaMax) / (2 * mu);
    const cflAdv = (0.25 * dxMin) / Math.max(1e-12, uMax);
    const cflDiff =
      (0.2 * dxMin * dxMin) / Math.max(1e-12, p.vorticityDiffusion, p.gammaDiffusion * 1e6);
    return Math.max(1e-9, Math.min(dtRel, cflAdv, cflDiff));
  }

  /** 有限体积膜厚更新（一个稳定子步） */
  private updateThickness(dt: number, recipe: SoapRecipe, p: SimParams): void {
    const { nTheta, nPhi } = this.dims;
    const r = p.radius;
    const dTheta = Math.PI / nTheta;
    const dPhi = (2 * Math.PI) / nPhi;
    const hNew = new Float64Array(this.h.length);
    for (let j = 0; j < nTheta; j++) {
      const thetaC = (j + 0.5) * dTheta;
      for (let k = 0; k < nPhi; k++) {
        const i = this.idx(j, k);
        // 北/南纬度面
        const thetaN = (j + 1) * dTheta;
        const thetaS = j * dTheta;
        const hN = 0.5 * (this.h[i] + this.h[this.idx(Math.min(nTheta - 1, j + 1), k)]);
        const hS = 0.5 * (this.h[i] + this.h[this.idx(Math.max(0, j - 1), k)]);
        const dSdTN =
          (sigmaOfGamma(recipe, this.gamma[this.idx(Math.min(nTheta - 1, j + 1), k)]) -
            sigmaOfGamma(recipe, this.gamma[i])) /
          dTheta;
        const dSdTS =
          (sigmaOfGamma(recipe, this.gamma[i]) -
            sigmaOfGamma(recipe, this.gamma[this.idx(Math.max(0, j - 1), k)])) /
          dTheta;
        // 东/西经度面
        const hE = 0.5 * (this.h[i] + this.h[this.idx(j, k + 1)]);
        const hW = 0.5 * (this.h[i] + this.h[this.idx(j, k - 1)]);
        const dSdPE =
          (sigmaOfGamma(recipe, this.gamma[this.idx(j, k + 1)]) -
            sigmaOfGamma(recipe, this.gamma[i])) /
          dPhi;
        const dSdPW =
          (sigmaOfGamma(recipe, this.gamma[i]) -
            sigmaOfGamma(recipe, this.gamma[this.idx(j, k - 1)])) /
          dPhi;
        const fN = faceFlux(hN, thetaN, dSdTN, 0, r, recipe);
        const fS = faceFlux(hS, thetaS, dSdTS, 0, r, recipe);
        const fE = faceFlux(hE, thetaC, 0, dSdPE, r, recipe);
        const fW = faceFlux(hW, thetaC, 0, dSdPW, r, recipe);

        // 旋涡速度对通量的贡献：uθ = (1/(R sinθ)) ∂ψ/∂φ，uφ = -(1/R) ∂ψ/∂θ
        const sinFloor = Math.sin(dTheta / 2);
        const uThetaN = (this.psi[this.idx(Math.min(nTheta - 1, j + 1), k)] - this.psi[i]) /
          (r * Math.max(Math.sin(thetaN), sinFloor) * dPhi);
        const uThetaS = (this.psi[i] - this.psi[this.idx(Math.max(0, j - 1), k)]) /
          (r * Math.max(Math.sin(thetaS), sinFloor) * dPhi);
        const uPhiE = -(this.psi[this.idx(j, k + 1)] - this.psi[i]) / (r * dTheta);
        const uPhiW = -(this.psi[i] - this.psi[this.idx(j, k - 1)]) / (r * dTheta);

        const sinN = Math.sin(thetaN);
        const sinS = Math.sin(thetaS);
        const sinC = Math.max(Math.sin(thetaC), sinFloor);
        // 进出单元的总体积通量（m³/s），乘面元弧长
        const qOut =
          dPhi * r * (sinN * (fN.qTheta + hN * uThetaN) - sinS * (fS.qTheta + hS * uThetaS)) +
          dTheta * r * sinC * (fE.qPhi + hE * uPhiE - (fW.qPhi + hW * uPhiW));
        const area = r * r * sinC * dTheta * dPhi;
        let h = this.h[i] - (dt / area) * qOut - recipe.evaporationRate * dt;
        // 南极开放边界：液体流入底部 Plateau 边界储液槽，
        // 以本环特征排流时间（dx/u_grav）指数松弛，防止极区几何收敛造成膜厚无界堆积
        if (j === nTheta - 1) {
          const uDrain =
            (recipe.density * GRAVITY * this.h[i] * this.h[i]) / (3 * recipe.viscosity) + 1e-12;
          const drainTau = (r * dTheta) / uDrain;
          h -= (dt * (this.h[i] - recipe.initialThickness)) / drainTau;
        }
        if (!Number.isFinite(h)) h = this.h[i];
        // 膜厚物理区间：下限为黑膜稳定厚度的 0.4 倍，上限为 Plateau 边界厚度
        h = Math.max(recipe.hBlack * 0.1, Math.min(25 * recipe.initialThickness, h));
        hNew[i] = h;
      }
    }
    this.h = hNew;
  }

  private areaSum(r: number): number {
    const { nTheta, nPhi } = this.dims;
    const dTheta = Math.PI / nTheta;
    const dPhi = (2 * Math.PI) / nPhi;
    let a = 0;
    for (let j = 0; j < nTheta; j++) a += Math.sin((j + 0.5) * dTheta);
    return a * dTheta * dPhi * r * r;
  }

  totalFilmVolume(): number {
    const { nTheta, nPhi } = this.dims;
    const dTheta = Math.PI / nTheta;
    const dPhi = (2 * Math.PI) / nPhi;
    let v = 0;
    for (let j = 0; j < nTheta; j++) {
      let ring = 0;
      for (let k = 0; k < nPhi; k++) ring += this.h[j * nPhi + k];
      v += Math.sin((j + 0.5) * dTheta) * ring * dPhi;
    }
    return v * dTheta;
  }

  private advectVorticityAndGamma(dt: number, recipe: SoapRecipe, p: SimParams): void {
    const { nTheta, nPhi } = this.dims;
    const r = p.radius;
    const dTheta = Math.PI / nTheta;
    const dPhi = (2 * Math.PI) / nPhi;
    // 极区 sinθ 的物理下限：首环中心到极点的角距离，避免 1/sinθ 发散
    const sinFloor = Math.sin(dTheta / 2);
    const isPolarRing = (j: number) => j === 0 || j === nTheta - 1;
    const omegaNew = new Float64Array(this.omega.length);
    const gammaNew = new Float64Array(this.gamma.length);
    for (let j = 0; j < nTheta; j++) {
      const thetaC = (j + 0.5) * dTheta;
      const sinSafe = Math.max(Math.sin(thetaC), sinFloor);
      for (let k = 0; k < nPhi; k++) {
        const i = this.idx(j, k);
        // 斜压注入：经度方向表面张力梯度产生扭矩 ∂ω/∂t ∝ (1/(R sinθ)) ∂σ/∂φ
        // 极环上经度方向无定义，关闭该项（极点由经向通量自然处理）
        const dSdPhi = isPolarRing(j)
          ? 0
          : (sigmaOfGamma(recipe, this.gamma[this.idx(j, k + 1)]) -
              sigmaOfGamma(recipe, this.gamma[this.idx(j, k - 1)])) /
            (2 * dPhi);
        const baroclinic = (p.baroclinicGain / (r * sinSafe)) * dSdPhi;
        // 当前速度（通量/h）
        const f = faceFlux(this.h[i], thetaC, 0, 0, r, recipe);
        const uTheta = f.qTheta / Math.max(this.h[i], 1e-12);
        const uPhi = f.qPhi / Math.max(this.h[i], 1e-12);
        // 半拉格朗日回源点（极区 sinθ 钳制，避免经度速度发散）
        const thetaB = Math.min(Math.PI - dTheta / 2, Math.max(dTheta / 2, thetaC - (uTheta / r) * dt));
        let phiB = (k + 0.5) * dPhi - (uPhi / (r * sinSafe)) * dt;
        phiB = ((phiB % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        const omegaAdv = sampleField(this.omega, this.dims, thetaB, phiB);
        const gammaAdv = sampleField(this.gamma, this.dims, thetaB, phiB);
        // 扩散（中心差分，经度方向带 1/sin²θ 度量）
        const lapOmega = this.laplacian(this.omega, j, k, thetaC, dTheta, dPhi);
        const lapGamma = this.laplacian(this.gamma, j, k, thetaC, dTheta, dPhi);
        const omegaV = omegaAdv + dt * (baroclinic + p.vorticityDiffusion * lapOmega);
        // 涡量钳制：量纲为 1/s，防止极端梯度下数值爆炸
        omegaNew[i] = Math.max(-1e4, Math.min(1e4, Number.isFinite(omegaV) ? omegaV : 0));
        gammaNew[i] = Math.min(1, Math.max(0, gammaAdv + dt * p.gammaDiffusion * lapGamma));
      }
    }
    this.omega = omegaNew;
    this.gamma = gammaNew;
  }

  private laplacian(
    field: Float64Array,
    j: number,
    k: number,
    thetaC: number,
    dTheta: number,
    dPhi: number,
  ): number {
    const { nTheta } = this.dims;
    const i = this.idx(j, k);
    const jN = this.idx(Math.min(nTheta - 1, j + 1), k);
    const jS = this.idx(Math.max(0, j - 1), k);
    const kE = this.idx(j, k + 1);
    const kW = this.idx(j, k - 1);
    const d2T = (field[jN] - 2 * field[i] + field[jS]) / (dTheta * dTheta);
    const sinSafe = Math.max(Math.sin(thetaC), Math.sin(dTheta / 2));
    const cot = Math.cos(thetaC) / sinSafe;
    const d1T = (field[jN] - field[jS]) / (2 * dTheta);
    const d2P = (field[kE] - 2 * field[i] + field[kW]) / (dPhi * dPhi * sinSafe * sinSafe);
    return d2T + cot * d1T + d2P;
  }

  private solveStreamFunction(dt: number, recipe: SoapRecipe, p: SimParams): void {
    void dt;
    void recipe;
    const { nTheta, nPhi } = this.dims;
    const dTheta = Math.PI / nTheta;
    const dPhi = (2 * Math.PI) / nPhi;
    let psi = this.psi;
    const relax = 0.6; // 欠松弛：极区 cot 项破坏对角占优，防止雅可比发散
    for (let iter = 0; iter < p.jacobiIterations; iter++) {
      const next = new Float64Array(psi.length);
      for (let j = 0; j < nTheta; j++) {
        const thetaC = (j + 0.5) * dTheta;
        const sinSafe = Math.max(Math.sin(thetaC), Math.sin(dTheta / 2));
        const sin2 = sinSafe * sinSafe;
        const cot = Math.cos(thetaC) / sinSafe;
        for (let k = 0; k < nPhi; k++) {
          const i = this.idx(j, k);
          const jN = this.idx(Math.min(nTheta - 1, j + 1), k);
          const jS = this.idx(Math.max(0, j - 1), k);
          const kE = this.idx(j, k + 1);
          const kW = this.idx(j, k - 1);
          const aT = 1 / (dTheta * dTheta);
          const aP = 1 / (dPhi * dPhi * sin2);
          const diag = 2 * (aT + aP);
          // 方程 ∇²ψ = -ω，球面 cot 一阶项保持显式
          const cotTerm = (cot / (2 * dTheta)) * (psi[jN] - psi[jS]);
          const gs = (aT * (psi[jN] + psi[jS]) + aP * (psi[kE] + psi[kW]) + this.omega[i] - cotTerm) / diag;
          const v = psi[i] + relax * (gs - psi[i]);
          next[i] = Number.isFinite(v) ? v : 0;
        }
      }
      psi = next;
    }
    // 去均值，避免直流漂移
    let mean = 0;
    for (const v of psi) mean += v;
    mean /= psi.length;
    for (let i = 0; i < psi.length; i++) psi[i] -= mean;
    this.psi = psi;
  }

  /** 顶部（北极附近）平均膜厚 */
  topThickness(): number {
    const { nPhi } = this.dims;
    let s = 0;
    for (let k = 0; k < nPhi; k++) s += this.h[k];
    return s / nPhi;
  }

  /** 底部（南极附近）平均膜厚 */
  bottomThickness(): number {
    const { nPhi, nTheta } = this.dims;
    let s = 0;
    const base = (nTheta - 1) * nPhi;
    for (let k = 0; k < nPhi; k++) s += this.h[base + k];
    return s / nPhi;
  }

  /** 沿一条经线的膜厚剖面（北极 -> 南极） */
  meridianProfile(): Float64Array {
    const { nTheta, nPhi } = this.dims;
    const out = new Float64Array(nTheta);
    for (let j = 0; j < nTheta; j++) out[j] = this.h[j * nPhi];
    return out;
  }
}
