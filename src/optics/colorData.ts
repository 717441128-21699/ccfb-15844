/**
 * CIE 1931 2° 标准色度观察者配色函数 x̄/ȳ/z̄ 与 D65 相对光谱功率。
 * 数据来源：CIE 15:2004，10nm 等间隔（380–780nm），D65 在 560nm 归一为 100。
 */

export const LAMBDA_MIN = 380;
export const LAMBDA_MAX = 780;
export const LAMBDA_STEP = 10;

export interface SpectrumPoint {
  lambda: number;
  xbar: number;
  ybar: number;
  zbar: number;
  d65: number;
}

export const CIE_DATA: SpectrumPoint[] = [
  { lambda: 380, xbar: 0.001368, ybar: 0.000039, zbar: 0.00645, d65: 49.9755 },
  { lambda: 390, xbar: 0.004243, ybar: 0.00012, zbar: 0.02005, d65: 54.6482 },
  { lambda: 400, xbar: 0.01431, ybar: 0.000396, zbar: 0.06785, d65: 82.7549 },
  { lambda: 410, xbar: 0.04351, ybar: 0.00121, zbar: 0.2074, d65: 91.486 },
  { lambda: 420, xbar: 0.13438, ybar: 0.004, zbar: 0.6456, d65: 93.4318 },
  { lambda: 430, xbar: 0.2839, ybar: 0.0116, zbar: 1.3856, d65: 86.687 },
  { lambda: 440, xbar: 0.34828, ybar: 0.023, zbar: 1.74706, d65: 104.865 },
  { lambda: 450, xbar: 0.3362, ybar: 0.038, zbar: 1.77211, d65: 117.008 },
  { lambda: 460, xbar: 0.2908, ybar: 0.06, zbar: 1.6692, d65: 117.812 },
  { lambda: 470, xbar: 0.19536, ybar: 0.09098, zbar: 1.28764, d65: 114.861 },
  { lambda: 480, xbar: 0.09564, ybar: 0.13902, zbar: 0.81295, d65: 115.923 },
  { lambda: 490, xbar: 0.03201, ybar: 0.20802, zbar: 0.46518, d65: 108.811 },
  { lambda: 500, xbar: 0.0049, ybar: 0.323, zbar: 0.272, d65: 109.354 },
  { lambda: 510, xbar: 0.0093, ybar: 0.503, zbar: 0.1582, d65: 107.802 },
  { lambda: 520, xbar: 0.06327, ybar: 0.71, zbar: 0.07825, d65: 104.79 },
  { lambda: 530, xbar: 0.1655, ybar: 0.862, zbar: 0.04216, d65: 107.689 },
  { lambda: 540, xbar: 0.2904, ybar: 0.954, zbar: 0.0203, d65: 104.405 },
  { lambda: 550, xbar: 0.43345, ybar: 0.99495, zbar: 0.00875, d65: 104.046 },
  { lambda: 560, xbar: 0.5945, ybar: 1.0, zbar: 0.0039, d65: 100.0 },
  { lambda: 570, xbar: 0.7621, ybar: 0.952, zbar: 0.0021, d65: 96.3342 },
  { lambda: 580, xbar: 0.9163, ybar: 0.87, zbar: 0.00165, d65: 95.788 },
  { lambda: 590, xbar: 1.0263, ybar: 0.757, zbar: 0.0011, d65: 88.6856 },
  { lambda: 600, xbar: 1.0622, ybar: 0.631, zbar: 0.0008, d65: 90.0062 },
  { lambda: 610, xbar: 1.0026, ybar: 0.503, zbar: 0.00034, d65: 89.5959 },
  { lambda: 620, xbar: 0.85445, ybar: 0.381, zbar: 0.00019, d65: 87.6987 },
  { lambda: 630, xbar: 0.6424, ybar: 0.265, zbar: 0.00005, d65: 83.2886 },
  { lambda: 640, xbar: 0.4479, ybar: 0.175, zbar: 0.00002, d65: 83.6992 },
  { lambda: 650, xbar: 0.2835, ybar: 0.107, zbar: 0, d65: 80.0268 },
  { lambda: 660, xbar: 0.1649, ybar: 0.061, zbar: 0, d65: 80.2146 },
  { lambda: 670, xbar: 0.0874, ybar: 0.032, zbar: 0, d65: 82.2778 },
  { lambda: 680, xbar: 0.04677, ybar: 0.017, zbar: 0, d65: 78.2842 },
  { lambda: 690, xbar: 0.0227, ybar: 0.00821, zbar: 0, d65: 69.7213 },
  { lambda: 700, xbar: 0.011359, ybar: 0.004102, zbar: 0, d65: 71.6091 },
  { lambda: 710, xbar: 0.00579, ybar: 0.002091, zbar: 0, d65: 74.349 },
  { lambda: 720, xbar: 0.002899, ybar: 0.001047, zbar: 0, d65: 61.6064 },
  { lambda: 730, xbar: 0.00144, ybar: 0.00052, zbar: 0, d65: 69.8866 },
  { lambda: 740, xbar: 0.00069, ybar: 0.000249, zbar: 0, d65: 75.0871 },
  { lambda: 750, xbar: 0.000332, ybar: 0.00012, zbar: 0, d65: 63.5927 },
  { lambda: 760, xbar: 0.000166, ybar: 0.00006, zbar: 0, d65: 46.4182 },
  { lambda: 770, xbar: 0.000083, ybar: 0.00003, zbar: 0, d65: 66.8094 },
  { lambda: 780, xbar: 0.000042, ybar: 0.000015, zbar: 0, d65: 63.3756 },
];
