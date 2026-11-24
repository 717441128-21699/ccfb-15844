// 膜厚流动仿真的公共 WGSL 定义。
// 数学公式与 src/physics/reference.ts 逐式对应，单元测试以 TS 参考为基准。

struct SimUniforms {
  // 网格
  nTheta: u32,
  nPhi: u32,
  // 物理
  radius: f32,        // 泡泡半径 m
  dt: f32,            // 本子步物理时间 s（已含时间加速）
  viscosity: f32,     // μ Pa·s
  density: f32,       // ρ kg/m³
  gravity: f32,       // g m/s²
  surfaceTension0: f32,   // σ₀ N/m
  surfaceElasticity: f32, // E_s N/m
  evaporationRate: f32,   // E m/s
  vorticityDiffusion: f32,
  gammaDiffusion: f32,
  baroclinicGain: f32,
  jacobiIterations: u32,
  hBlack: f32,
  hInitial: f32,
  hMaxCap: f32,
  time: f32,
  // 手势交互
  interactionMode: u32,  // 0 无, 1 吹, 2 戳, 3 吹气
  interactionTheta: f32,
  interactionPhi: f32,
  interactionStrength: f32,
  interactionRadius: f32,
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(0) var<uniform> U: SimUniforms;
@group(0) @binding(1) var hIn: texture_2d<f32>;
@group(0) @binding(2) var gammaIn: texture_2d<f32>;
@group(0) @binding(3) var omegaIn: texture_2d<f32>;
@group(0) @binding(4) var psiIn: texture_2d<f32>;
@group(0) @binding(5) var hOut: texture_storage_2d<rgba32float, write>;
@group(0) @binding(6) var gammaOut: texture_storage_2d<rgba32float, write>;
@group(0) @binding(7) var omegaOut: texture_storage_2d<rgba32float, write>;
@group(0) @binding(8) var psiOut: texture_storage_2d<rgba32float, write>;

fn cellDims() -> vec2<f32> {
  return vec2<f32>(3.14159265 / f32(U.nTheta), 6.2831853 / f32(U.nPhi));
}

fn sinFloor() -> f32 {
  return sin(cellDims().x * 0.5);
}

fn safeSin(theta: f32) -> f32 {
  return max(sin(theta), sinFloor());
}

// WGSL 无 isFinite 内置，且不同版本 isNan/isInf 命名有差异，用数值性质判断：
// NaN 是唯一不等于自身的值；超过 f32 最大有限值即 Inf。
fn isfinite(x: f32) -> bool {
  return x == x && abs(x) < 3.4e38;
}

// σ(Γ) = σ₀ + E_s(0.5 - Γ)
fn sigmaOfGamma(gammaNorm: f32) -> f32 {
  return U.surfaceTension0 + U.surfaceElasticity * (0.5 - gammaNorm);
}

// 周期经度索引
fn wrapK(k: i32) -> i32 {
  let np = i32(U.nPhi);
  var kk = k % np;
  if (kk < 0) { kk = kk + np; }
  return kk;
}

fn clampJ(j: i32) -> i32 {
  return clamp(j, 0, i32(U.nTheta) - 1);
}

fn loadH(j: i32, k: i32) -> f32 {
  return textureLoad(hIn, vec2<i32>(wrapK(k), clampJ(j)), 0).r;
}
fn loadGamma(j: i32, k: i32) -> f32 {
  return textureLoad(gammaIn, vec2<i32>(wrapK(k), clampJ(j)), 0).r;
}
fn loadOmega(j: i32, k: i32) -> f32 {
  return textureLoad(omegaIn, vec2<i32>(wrapK(k), clampJ(j)), 0).r;
}
fn loadPsi(j: i32, k: i32) -> f32 {
  return textureLoad(psiIn, vec2<i32>(wrapK(k), clampJ(j)), 0).r;
}

fn loadSigma(j: i32, k: i32) -> f32 {
  return sigmaOfGamma(loadGamma(j, k));
}

// 面通量 q = ρg sinθ h³/(3μ) eθ + h²/(2μ) ∇σ（与 TS faceFlux 对应）
fn faceFluxTheta(hFace: f32, thetaFace: f32, dSigmaDtheta: f32) -> f32 {
  let mu = U.viscosity;
  let grav = U.density * U.gravity;
  let h2 = hFace * hFace;
  return grav * sin(thetaFace) * h2 * hFace / (3.0 * mu)
    + h2 * dSigmaDtheta / (2.0 * mu * U.radius);
}

fn faceFluxPhi(hFace: f32, thetaCell: f32, dSigmaDphi: f32) -> f32 {
  let mu = U.viscosity;
  let h2 = hFace * hFace;
  return h2 * dSigmaDphi / (2.0 * mu * U.radius * safeSin(thetaCell));
}

// 球面拉普拉斯标量（与 TS laplacian 对应）
fn laplacianField(tex: texture_2d<f32>, j: i32, k: i32, thetaC: f32) -> f32 {
  let d = cellDims();
  let dTheta = d.x;
  let dPhi = d.y;
  let v = textureLoad(tex, vec2<i32>(wrapK(k), clampJ(j)), 0).r;
  let vN = textureLoad(tex, vec2<i32>(wrapK(k), clampJ(j + 1)), 0).r;
  let vS = textureLoad(tex, vec2<i32>(wrapK(k), clampJ(j - 1)), 0).r;
  let vE = textureLoad(tex, vec2<i32>(wrapK(k + 1), clampJ(j)), 0).r;
  let vW = textureLoad(tex, vec2<i32>(wrapK(k - 1), clampJ(j)), 0).r;
  let s = safeSin(thetaC);
  let d2T = (vN - 2.0 * v + vS) / (dTheta * dTheta);
  let d1T = (vN - vS) / (2.0 * dTheta);
  let d2P = (vE - 2.0 * v + vW) / (dPhi * dPhi * s * s);
  return d2T + (cos(thetaC) / s) * d1T + d2P;
}
