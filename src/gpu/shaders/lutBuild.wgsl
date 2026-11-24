// 干涉 LUT 生成：每个纹素 = (膜厚 h, 入射角 θI) 对应的线性 sRGB。
// 全光谱 380–780nm 步长 10nm（41 点），D65 加权积分到 CIE XYZ 再转线性 sRGB。
// 与 src/optics/interference.ts 逐式对应。

struct LutUniforms {
  hMax: f32,
  angleMax: f32,
  hBins: u32,
  angleBins: u32,
  cauchyA: f32,
  cauchyB: f32,
};
@group(0) @binding(0) var<uniform> U: LutUniforms;
@group(0) @binding(1) var lutOut: texture_storage_2d<rgba16float, write>;

// CIE 1931 x̄/ȳ/z̄ 与 D65，41 点（380..780nm，10nm 步长）
struct Spectrum { lambda: f32, xbar: f32, ybar: f32, zbar: f32, d65: f32 };

fn cie(i: u32) -> Spectrum {
  var s: Spectrum;
  // 数据与 src/optics/colorData.ts 完全一致
  let data = array<vec4<f32>, 41>(
    vec4<f32>(0.001368, 0.000039, 0.00645, 49.9755),
    vec4<f32>(0.004243, 0.00012, 0.02005, 54.6482),
    vec4<f32>(0.01431, 0.000396, 0.06785, 82.7549),
    vec4<f32>(0.04351, 0.00121, 0.2074, 91.486),
    vec4<f32>(0.13438, 0.004, 0.6456, 93.4318),
    vec4<f32>(0.2839, 0.0116, 1.3856, 86.687),
    vec4<f32>(0.34828, 0.023, 1.74706, 104.865),
    vec4<f32>(0.3362, 0.038, 1.77211, 117.008),
    vec4<f32>(0.2908, 0.06, 1.6692, 117.812),
    vec4<f32>(0.19536, 0.09098, 1.28764, 114.861),
    vec4<f32>(0.09564, 0.13902, 0.81295, 115.923),
    vec4<f32>(0.03201, 0.20802, 0.46518, 108.811),
    vec4<f32>(0.0049, 0.323, 0.272, 109.354),
    vec4<f32>(0.0093, 0.503, 0.1582, 107.802),
    vec4<f32>(0.06327, 0.71, 0.07825, 104.79),
    vec4<f32>(0.1655, 0.862, 0.04216, 107.689),
    vec4<f32>(0.2904, 0.954, 0.0203, 104.405),
    vec4<f32>(0.43345, 0.99495, 0.00875, 104.046),
    vec4<f32>(0.5945, 1.0, 0.0039, 100.0),
    vec4<f32>(0.7621, 0.952, 0.0021, 96.3342),
    vec4<f32>(0.9163, 0.87, 0.00165, 95.788),
    vec4<f32>(1.0263, 0.757, 0.0011, 88.6856),
    vec4<f32>(1.0622, 0.631, 0.0008, 90.0062),
    vec4<f32>(1.0026, 0.503, 0.00034, 89.5959),
    vec4<f32>(0.85445, 0.381, 0.00019, 87.6987),
    vec4<f32>(0.6424, 0.265, 0.00005, 83.2886),
    vec4<f32>(0.4479, 0.175, 0.00002, 83.6992),
    vec4<f32>(0.2835, 0.107, 0.0, 80.0268),
    vec4<f32>(0.1649, 0.061, 0.0, 80.2146),
    vec4<f32>(0.0874, 0.032, 0.0, 82.2778),
    vec4<f32>(0.04677, 0.017, 0.0, 78.2842),
    vec4<f32>(0.0227, 0.00821, 0.0, 69.7213),
    vec4<f32>(0.011359, 0.004102, 0.0, 71.6091),
    vec4<f32>(0.00579, 0.002091, 0.0, 74.349),
    vec4<f32>(0.002899, 0.001047, 0.0, 61.6064),
    vec4<f32>(0.00144, 0.00052, 0.0, 69.8866),
    vec4<f32>(0.00069, 0.000249, 0.0, 75.0871),
    vec4<f32>(0.000332, 0.00012, 0.0, 63.5927),
    vec4<f32>(0.000166, 0.00006, 0.0, 46.4182),
    vec4<f32>(0.000083, 0.00003, 0.0, 66.8094),
    vec4<f32>(0.000042, 0.000015, 0.0, 63.3756),
  );
  let row = data[i];
  s.lambda = 380.0 + f32(i) * 10.0;
  s.xbar = row.x; s.ybar = row.y; s.zbar = row.z; s.d65 = row.w;
  return s;
}

// 对称膜（空气-膜-空气）单偏振反射率
fn symmetricReflectance(r12: f32, delta: f32) -> f32 {
  let r2 = r12 * r12;
  let cosD = cos(delta);
  let num = r2 * (2.0 - 2.0 * cosD);
  let den = 1.0 + r2 * r2 - 2.0 * r2 * cosD;
  return num / max(den, 1e-12);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let t = gid.x; // 膜厚 bin
  let a = gid.y; // 角度 bin
  if (t >= U.hBins || a >= U.angleBins) { return; }
  let h = (f32(t) + 0.5) / f32(U.hBins) * U.hMax;
  let thetaI = f32(a) / max(1.0, f32(U.angleBins) - 1.0) * U.angleMax;
  let cosI = cos(thetaI);

  var X = 0.0; var Y = 0.0; var Z = 0.0;
  var Yn = 0.0;
  for (var i = 0u; i < 41u; i = i + 1u) {
    let sp = cie(i);
    let lambdaUm = sp.lambda * 1e-3;
    let n = U.cauchyA + U.cauchyB / (lambdaUm * lambdaUm);
    let sinT2 = sin(thetaI) / n;
    let cosT2 = sqrt(max(0.0, 1.0 - sinT2 * sinT2));
    let rs = (cosI - n * cosT2) / (cosI + n * cosT2);
    let rp = (n * cosI - cosT2) / (n * cosI + cosT2);
    let delta = 4.0 * 3.14159265 * n * h * cosT2 / (sp.lambda * 1e-9);
    let refl = 0.5 * (symmetricReflectance(rs, delta) + symmetricReflectance(rp, delta));
    X = X + sp.d65 * refl * sp.xbar;
    Y = Y + sp.d65 * refl * sp.ybar;
    Z = Z + sp.d65 * refl * sp.zbar;
    Yn = Yn + sp.d65 * sp.ybar;
  }
  X = X / Yn; Y = Y / Yn; Z = Z / Yn;
  // XYZ(D65) -> 线性 sRGB
  let rLin = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
  let gLin = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
  let bLin = 0.0557 * X - 0.204 * Y + 1.057 * Z;
  textureStore(lutOut, vec2<i32>(i32(t), i32(a)), vec4<f32>(rLin, gLin, bLin, 1.0));
}
