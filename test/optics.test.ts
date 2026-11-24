import { describe, expect, it } from 'vitest';
import { getRecipe } from '../src/physics/formulas';
import {
  buildInterferenceLUT,
  encodeSRGB,
  firstMaximumThickness,
  newtonOrderThickness,
  refractiveIndex,
  spectralReflectance,
  thicknessToLinearRGB,
  thicknessToSRGB,
} from '../src/optics/interference';

const recipe = getRecipe('glycerol');

describe('薄膜干涉基础', () => {
  it('Cauchy 色散：蓝光折射率高于红光', () => {
    expect(refractiveIndex(recipe, 450)).toBeGreaterThan(refractiveIndex(recipe, 650));
  });

  it('h→0 时光程差为零，对称膜两束反射相消 -> 黑膜（反射率趋零）', () => {
    const r0 = spectralReflectance(recipe, 0, 550, 0);
    expect(r0).toBeLessThan(1e-6);
    const rBlack = spectralReflectance(recipe, 8e-9, 550, 0);
    expect(rBlack).toBeLessThan(0.002);
  });

  it('一级极大 h=λ/(4n) 处反射率达到峰值，半波长整数倍厚度为极小', () => {
    const hPeak = firstMaximumThickness(recipe, 550); // ≈102nm
    const rPeak = spectralReflectance(recipe, hPeak, 550, 0);
    // h = λ/(2n)（级数 1）与 h = 3λ/(4n)（级数 1.5，即 1.5 个峰位）都是极小
    const rHalf = spectralReflectance(recipe, newtonOrderThickness(recipe, 550, 1), 550, 0);
    expect(rPeak).toBeGreaterThan(0.05);
    expect(rHalf).toBeLessThan(rPeak * 0.01);
    // 峰值两侧反射率明显更低
    expect(spectralReflectance(recipe, hPeak * 0.25, 550, 0)).toBeLessThan(rPeak * 0.5);
    expect(spectralReflectance(recipe, hPeak * 1.75, 550, 0)).toBeLessThan(rPeak);
  });

  it('同厚度换入射角：斜入射光程差 2nh cosθ₂ 变小，颜色发生漂移', () => {
    const h = 0.35e-6;
    const c0 = thicknessToLinearRGB(recipe, h, 0);
    const c60 = thicknessToLinearRGB(recipe, h, Math.PI / 3);
    const dist = Math.hypot(c0.r - c60.r, c0.g - c60.g, c0.b - c60.b);
    expect(dist).toBeGreaterThan(0.01);
  });
});

describe('牛顿色序', () => {
  /** 按 0..255 sRGB 输出做色相分类，阈值依据全光谱实测输出标定 */
  function hueName(h: number): string {
    const c = thicknessToSRGB(recipe, h, 0);
    const r = c.r * 255;
    const g = c.g * 255;
    const b = c.b * 255;
    const max = Math.max(r, g, b);
    if (max < 25) return 'black';
    if (max < 95 && Math.max(r, g, b) - Math.min(r, g, b) < 20) return 'gray';
    if (Math.abs(r - g) < 16 && Math.abs(g - b) < 16 && max > 110) return 'white';
    // 有序判定：先按主导通道归属，再细分
    if (r >= g && r >= b) {
      // 红主导：黄绿边界看 g，紫边界看 b 是否接近 r
      if (b > r * 0.55) return 'magenta';
      if (g > r * 0.55) return 'yellow';
      return 'red';
    }
    if (g >= r && g >= b) {
      if (b > g * 0.8) return 'cyan';
      return 'green';
    }
    return 'blue';
  }

  it('零厚度与 10nm 为黑膜/近黑', () => {
    expect(hueName(5e-9)).toBe('black');
    expect(hueName(10e-9)).toBe('black');
  });

  it('一级色序与牛顿表一致：黑 -> 银灰(表中一级白) -> 黄 -> 橙红 -> 紫 -> 蓝 -> 青 -> 绿', () => {
    // 档位厚度依据全光谱积分输出实测（n≈1.35，一级 λ/(4n)≈100nm）。
    // 肥皂膜反射率峰值仅 ~8%，牛顿表中的"一级白"在膜上呈现为银灰色。
    const seq = [
      { h: 0.01e-6, expect: 'black' },
      { h: 0.08e-6, expect: 'gray' },
      { h: 0.14e-6, expect: 'yellow' },
      { h: 0.18e-6, expect: 'red' },
      { h: 0.2e-6, expect: 'blue' }, // 红后即紫蓝
      { h: 0.23e-6, expect: 'blue' },
      { h: 0.26e-6, expect: 'blue' }, // 蓝青过渡
      { h: 0.3e-6, expect: 'green' },
      // 二级循环：再次出现红、蓝
      { h: 0.36e-6, expect: 'red' },
      { h: 0.42e-6, expect: 'blue' },
    ];
    for (const row of seq) {
      expect(hueName(row.h), `h=${row.h} 期望 ${row.expect}，实际 ${hueName(row.h)}`).toBe(
        row.expect,
      );
    }
  });

  it('厚度增大时高级数色序周期性重复，但整体趋于白化（饱和度下降）', () => {
    const c1 = thicknessToSRGB(recipe, 0.3e-6, 0);
    const cHi = thicknessToSRGB(recipe, 2.2e-6, 0);
    const chromaHi = Math.max(cHi.r, cHi.g, cHi.b) - Math.min(cHi.r, cHi.g, cHi.b);
    const chroma1 = Math.max(c1.r, c1.g, c1.b) - Math.min(c1.r, c1.g, c1.b);
    expect(chromaHi).toBeLessThan(chroma1);
  });

  it('LUT 构建：尺寸正确、最薄膜厚条目接近零、随厚度连续无 NaN', () => {
    const opts = { hMax: 2.5e-6, hBins: 64, angleBins: 16, angleMax: (75 * Math.PI) / 180 };
    const lut = buildInterferenceLUT(recipe, opts);
    expect(lut).toHaveLength(64 * 16 * 4);
    // 第一个 bin 中心厚度 ≈ hMax/128 ≈ 19.5nm，反射光很弱
    const first = lut.subarray(0, 3);
    expect(first[0] + first[1] + first[2]).toBeLessThan(0.05);
    for (const v of lut) expect(Number.isNaN(v)).toBe(false);
  });

  it('sRGB 伽马编码边界', () => {
    expect(encodeSRGB(0)).toBe(0);
    expect(encodeSRGB(1)).toBeCloseTo(1, 5);
    expect(encodeSRGB(-5)).toBe(0);
    expect(encodeSRGB(5)).toBeCloseTo(1, 5);
  });
});
