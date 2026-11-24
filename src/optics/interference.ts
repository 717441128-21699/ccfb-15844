/**
 * 薄膜干涉的参考实现（纯 TypeScript，与 WGSL 光学着色器逐式对应）。
 *
 * 物理模型：
 * - 光在膜的上下两个界面各反射一次，两束反射光相位差 δ = 4π n h cosθ₂/λ。
 *   两侧介质都是空气，两个界面的反射相移相同（都是低→高，各 π），
 *   相对相移中 π 抵消，因此 h→0 时 δ→0、两束光振幅相消（r_total→0）→ 黑膜。
 * - 对 s、p 两个偏振分别用菲涅耳系数叠加，自然光取平均。
 * - 全光谱（380–780nm，41 个波长）加权 D65 与 CIE 1931 配色函数积分到 XYZ，
 *   再转线性 sRGB。厚度变化按 δ∝h 扫过各波长，自然得到牛顿色序。
 * - 入射角变化改变 cosθ₂ 与菲涅耳振幅，同一厚度换角度颜色也会变。
 */
import { CIE_DATA, type SpectrumPoint } from './colorData';
import type { SoapRecipe } from '../physics/formulas';

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** Cauchy 色散：λNm 单位 nm，内部转 μm */
export function refractiveIndex(recipe: SoapRecipe, lambdaNm: number): number {
  const lambdaUm = lambdaNm * 1e-3;
  return recipe.cauchyA + recipe.cauchyB / (lambdaUm * lambdaUm);
}

/** 单波长、单偏振的对称膜（空气-膜-空气）反射率，dPhi = δ 已含在调用处 */
function symmetricAmplitude(r12: number, delta: number): number {
  // r23 = -r12（对称膜第二界面是高→低），多光束等比求和：
  // r = r12(1 - e^{-iδ}) / (1 - r12² e^{-iδ})
  const r2 = r12 * r12;
  const cosD = Math.cos(delta);
  const sinD = Math.sin(delta);
  // |1 - e^{-iδ}|² = 2 - 2cosδ；|1 - r² e^{-iδ}|² = 1 + r⁴ - 2r²cosδ
  const num = r2 * (2 - 2 * cosD);
  const den = 1 + r2 * r2 - 2 * r2 * cosD;
  void sinD;
  return num / den;
}

/** 单波长膜反射率（自然光 = s/p 平均），h 单位 m，thetaI 为膜外入射角 rad */
export function spectralReflectance(
  recipe: SoapRecipe,
  h: number,
  lambdaNm: number,
  thetaI: number,
): number {
  const n = refractiveIndex(recipe, lambdaNm);
  const sinT2 = Math.sin(thetaI) / n;
  const cosT2 = Math.sqrt(Math.max(0, 1 - sinT2 * sinT2));
  const cosI = Math.cos(thetaI);
  // 菲涅耳振幅（空气侧入射 n0=1）
  const rs = (cosI - n * cosT2) / (cosI + n * cosT2);
  const rp = (n * cosI - cosT2) / (n * cosI + cosT2);
  const delta = (4 * Math.PI * n * h * cosT2) / (lambdaNm * 1e-9);
  const Rs = symmetricAmplitude(rs, delta);
  const Rp = symmetricAmplitude(rp, delta);
  return 0.5 * (Rs + Rp);
}

interface WhitePoint {
  xn: number;
  yn: number;
  zn: number;
}

let whiteCache: WhitePoint | null = null;

function whitePoint(): WhitePoint {
  if (whiteCache) return whiteCache;
  let xn = 0;
  let yn = 0;
  let zn = 0;
  for (const p of CIE_DATA) {
    xn += p.d65 * p.xbar;
    yn += p.d65 * p.ybar;
    zn += p.d65 * p.zbar;
  }
  whiteCache = { xn, yn, zn };
  return whiteCache;
}

/** 膜厚 h(m)、入射角 thetaI(rad) -> 线性 sRGB（未伽马，未钳制） */
export function thicknessToLinearRGB(
  recipe: SoapRecipe,
  h: number,
  thetaI: number,
): RGB {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of CIE_DATA as SpectrumPoint[]) {
    const refl = spectralReflectance(recipe, h, p.lambda, thetaI);
    x += p.d65 * refl * p.xbar;
    y += p.d65 * refl * p.ybar;
    z += p.d65 * refl * p.zbar;
  }
  const wp = whitePoint();
  // 反射率量纲：除以白点（完整漫反射）归一
  x /= wp.yn;
  y /= wp.yn;
  z /= wp.yn;
  // XYZ(D65) -> 线性 sRGB(D65)
  const r = 3.2406 * x - 1.5372 * y - 0.4986 * z;
  const g = -0.9689 * x + 1.8758 * y + 0.0415 * z;
  const b = 0.0557 * x - 0.204 * y + 1.057 * z;
  return { r, g, b };
}

/** 线性 sRGB 伽马编码并钳制到 0..1 */
export function encodeSRGB(c: number): number {
  const v = Math.min(1, Math.max(0, c));
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

export function thicknessToSRGB(recipe: SoapRecipe, h: number, thetaI: number): RGB {
  const lin = thicknessToLinearRGB(recipe, h, thetaI);
  return { r: encodeSRGB(lin.r), g: encodeSRGB(lin.g), b: encodeSRGB(lin.b) };
}

/**
 * 牛顿级数：厚度每增加 λ/(2 n cosθ₂)，该波长的反射状态重复一次。
 * 返回给定波长对应的"级数厚度" h_m = m λ/(2n)，m 从 0 起。
 */
export function newtonOrderThickness(
  recipe: SoapRecipe,
  lambdaNm: number,
  order: number,
  thetaI = 0,
): number {
  const n = refractiveIndex(recipe, lambdaNm);
  const sinT2 = Math.sin(thetaI) / n;
  const cosT2 = Math.sqrt(Math.max(0, 1 - sinT2 * sinT2));
  return (order * lambdaNm * 1e-9) / (2 * n * cosT2);
}

/** 第一个反射极大（一级亮纹）厚度 h = λ/(4n cosθ₂) */
export function firstMaximumThickness(
  recipe: SoapRecipe,
  lambdaNm: number,
  thetaI = 0,
): number {
  return newtonOrderThickness(recipe, lambdaNm, 1, thetaI) / 2;
}

export interface LUTBuildOptions {
  hMax: number;
  hBins: number;
  angleBins: number;
  /** 最大入射角 rad（布儒斯特角附近反射率过低，一般截到 75°） */
  angleMax: number;
}

export const DEFAULT_LUT_OPTIONS: LUTBuildOptions = {
  hMax: 2.5e-6,
  hBins: 256,
  angleBins: 64,
  angleMax: (75 * Math.PI) / 180,
};

/** CPU 版 LUT（测试与 WebGPU 不可用时的回退），数据按 [angle][h] 行主序存 RGBA */
export function buildInterferenceLUT(
  recipe: SoapRecipe,
  opts: LUTBuildOptions = DEFAULT_LUT_OPTIONS,
): Float32Array {
  const { hMax, hBins, angleBins, angleMax } = opts;
  const lut = new Float32Array(hBins * angleBins * 4);
  for (let a = 0; a < angleBins; a++) {
    const thetaI = (a / Math.max(1, angleBins - 1)) * angleMax;
    for (let t = 0; t < hBins; t++) {
      const h = ((t + 0.5) / hBins) * hMax;
      const c = thicknessToLinearRGB(recipe, h, thetaI);
      const o = (a * hBins + t) * 4;
      lut[o] = c.r;
      lut[o + 1] = c.g;
      lut[o + 2] = c.b;
      lut[o + 3] = 1;
    }
  }
  return lut;
}
