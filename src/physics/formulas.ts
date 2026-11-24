/**
 * 常见肥皂液配方及其物理参数。
 *
 * 黏度 μ、表面张力 σ、表面弹性 E_s、折射率（Cauchy 色散）、蒸发率等参数
 * 参考公开的肥皂膜实验文献取值区间（如 Couder/Benzaquen 排液实验、
 * Mysels 的黑膜厚度观测），按四种常见展项配方整理为可直接仿真的参数组。
 */

export interface SoapRecipe {
  id: string;
  /** 展项内名称 */
  name: string;
  /** 配方说明 */
  description: string;
  /** 质量分数组成（百分比，合计约 100） */
  composition: { ingredient: string; massFraction: number }[];
  /** 动力黏度 μ，Pa·s */
  viscosity: number;
  /** 密度 ρ，kg/m³ */
  density: number;
  /** 平衡表面张力 σ₀，N/m（含表面活性剂后的低值） */
  surfaceTension: number;
  /** 表面弹性（Gibbs 弹性）E_s = -Γ dσ/dΓ，N/m */
  surfaceElasticity: number;
  /** 表面活性剂饱和吸附量 Γmax，mol/m²（仿真中 Γ 用归一化浓度） */
  gammaMax: number;
  /** Cauchy 色散 n(λ) = A + B/λ² 的 A（λ 单位 μm） */
  cauchyA: number;
  /** Cauchy B，μm² */
  cauchyB: number;
  /** 蒸发减薄速率 E，m/s（展项环境湿度下的等效值） */
  evaporationRate: number;
  /** 初始膜厚 h₀，m */
  initialThickness: number;
  /** 灰膜（开始显暗）厚度，m */
  hGray: number;
  /** 黑膜形成厚度，m */
  hBlack: number;
  /** 黑膜面积占比达到该值时破裂 */
  popBlackFraction: number;
  /** 展项时间加速倍率（真实膜排液以小时计，大屏展示需加速） */
  defaultTimeScale: number;
}

export const GRAVITY = 9.81;

export const RECIPES: SoapRecipe[] = [
  {
    id: 'basic',
    name: '基础餐洗配方',
    description: '家里就能做的入门配方，黏度低、蒸发快，泡泡寿命短，颜色变化快、易破。',
    composition: [
      { ingredient: '清水', massFraction: 95 },
      { ingredient: '餐具洗涤剂', massFraction: 5 },
    ],
    viscosity: 1.1e-3,
    density: 1000,
    surfaceTension: 0.030,
    surfaceElasticity: 0.012,
    gammaMax: 3.0e-6,
    cauchyA: 1.335,
    cauchyB: 0.0032,
    evaporationRate: 1.4e-8,
    initialThickness: 1.0e-6,
    hGray: 3.5e-8,
    hBlack: 1.2e-8,
    popBlackFraction: 0.10,
    defaultTimeScale: 30,
  },
  {
    id: 'glycerol',
    name: '甘油长寿配方',
    description: '甘油提高黏度并锁住水分，排液与蒸发都变慢，漩涡流动停留更久，泡泡寿命明显变长。',
    composition: [
      { ingredient: '清水', massFraction: 82 },
      { ingredient: '餐具洗涤剂', massFraction: 10 },
      { ingredient: '甘油', massFraction: 8 },
    ],
    viscosity: 2.6e-3,
    density: 1020,
    surfaceTension: 0.029,
    surfaceElasticity: 0.018,
    gammaMax: 3.2e-6,
    cauchyA: 1.350,
    cauchyB: 0.0038,
    evaporationRate: 6.0e-9,
    initialThickness: 1.4e-6,
    hGray: 3.2e-8,
    hBlack: 1.0e-8,
    popBlackFraction: 0.12,
    defaultTimeScale: 45,
  },
  {
    id: 'sugar',
    name: '糖浆大泡配方',
    description: '糖浆让液体又稠又韧，适合吹直径一米以上的巨型泡，膜厚大、色序阶数多，排液很慢。',
    composition: [
      { ingredient: '清水', massFraction: 78 },
      { ingredient: '餐具洗涤剂', massFraction: 8 },
      { ingredient: '白砂糖/玉米糖浆', massFraction: 14 },
    ],
    viscosity: 4.2e-3,
    density: 1060,
    surfaceTension: 0.030,
    surfaceElasticity: 0.020,
    gammaMax: 3.1e-6,
    cauchyA: 1.362,
    cauchyB: 0.0042,
    evaporationRate: 4.0e-9,
    initialThickness: 1.8e-6,
    hGray: 3.0e-8,
    hBlack: 9.0e-9,
    popBlackFraction: 0.13,
    defaultTimeScale: 55,
  },
  {
    id: 'polymer',
    name: '专业展项配方',
    description: '高分子瓜尔胶提供强弹性网络，Marangoni 自愈效应最明显、漩涡最丰富，黑膜扩张慢，最适合全天连续展演。',
    composition: [
      { ingredient: '清水', massFraction: 90.0 },
      { ingredient: '月桂醇醚硫酸钠(SLES)', massFraction: 6.0 },
      { ingredient: '丙二醇', massFraction: 3.6 },
      { ingredient: '瓜尔胶', massFraction: 0.4 },
    ],
    viscosity: 6.5e-3,
    density: 1010,
    surfaceTension: 0.027,
    surfaceElasticity: 0.028,
    gammaMax: 3.4e-6,
    cauchyA: 1.344,
    cauchyB: 0.0035,
    evaporationRate: 2.5e-9,
    initialThickness: 2.0e-6,
    hGray: 2.8e-8,
    hBlack: 8.0e-9,
    popBlackFraction: 0.15,
    defaultTimeScale: 70,
  },
];

export function getRecipe(id: string): SoapRecipe {
  return RECIPES.find((r) => r.id === id) ?? RECIPES[0];
}
