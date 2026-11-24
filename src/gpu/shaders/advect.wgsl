// Pass 1：涡量斜压注入 + 涡量/表面活性剂的半拉格朗日平流与扩散。
// 对应 TS ReferenceFilm.advectVorticityAndGamma。
#include "./common.wgsl"

fn sampleBilinear(tex: texture_2d<f32>, theta: f32, phi: f32) -> f32 {
  let d = cellDims();
  let nt = f32(U.nTheta);
  let np = f32(U.nPhi);
  let fj = clamp((theta - d.x * 0.5) / d.x, 0.0, nt - 1.0001);
  var fk = (phi - d.y * 0.5) / d.y;
  fk = fk - floor(fk / np) * np; // 周期回绕
  let j0 = i32(floor(fj));
  let k0 = i32(floor(fk));
  let tj = fj - floor(fj);
  let tk = fk - floor(fk);
  let j1 = min(j0 + 1, i32(U.nTheta) - 1);
  let k1 = wrapK(k0 + 1);
  let a = textureLoad(tex, vec2<i32>(k0, j0), 0).r;
  let b = textureLoad(tex, vec2<i32>(k1, j0), 0).r;
  let c = textureLoad(tex, vec2<i32>(k0, j1), 0).r;
  let dd = textureLoad(tex, vec2<i32>(k1, j1), 0).r;
  return mix(mix(a, b, tk), mix(c, dd, tk), tj);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let k = i32(gid.x);
  let j = i32(gid.y);
  if (k >= i32(U.nPhi) || j >= i32(U.nTheta)) { return; }
  let d = cellDims();
  let thetaC = (f32(j) + 0.5) * d.x;
  let phiC = (f32(k) + 0.5) * d.y;
  let s = safeSin(thetaC);
  let polar = j == 0 || j == i32(U.nTheta) - 1;

  // 斜压注入 ∂ω/∂t = gain/(R sinθ) ∂σ/∂φ，极环关闭
  var dSdPhi = 0.0;
  if (!polar) {
    dSdPhi = (loadSigma(j, k + 1) - loadSigma(j, k - 1)) / (2.0 * d.y);
  }
  let baroclinic = U.baroclinicGain / (U.radius * s) * dSdPhi;

  // 当前重力速度（通量/h），用于半拉格朗日回源
  let hh = loadH(j, k);
  let qT = faceFluxTheta(hh, thetaC, 0.0);
  let uTheta = qT / max(hh, 1e-12);
  let uPhi = faceFluxPhi(hh, thetaC, 0.0) / max(hh, 1e-12);

  let thetaB = clamp(thetaC - uTheta / U.radius * U.dt, d.x * 0.5, 3.14159265 - d.x * 0.5);
  var phiB = phiC - uPhi / (U.radius * s) * U.dt;
  phiB = phiB - floor(phiB / 6.2831853) * 6.2831853;

  let omegaAdv = sampleBilinear(omegaIn, thetaB, phiB);
  let gammaAdv = sampleBilinear(gammaIn, thetaB, phiB);
  let lapOmega = laplacianField(omegaIn, j, k, thetaC);
  let lapGamma = laplacianField(gammaIn, j, k, thetaC);

  var omegaV = omegaAdv + U.dt * (baroclinic + U.vorticityDiffusion * lapOmega);
  omegaV = clamp(omegaV, -1e4, 1e4);
  if (!isfinite(omegaV)) { omegaV = 0.0; }
  var gammaV = clamp(gammaAdv + U.dt * U.gammaDiffusion * lapGamma, 0.0, 1.0);
  if (!isfinite(gammaV)) { gammaV = gammaAdv; }

  textureStore(omegaOut, vec2<i32>(k, j), vec4<f32>(omegaV, 0.0, 0.0, 1.0));
  textureStore(gammaOut, vec2<i32>(k, j), vec4<f32>(gammaV, 0.0, 0.0, 1.0));
}
