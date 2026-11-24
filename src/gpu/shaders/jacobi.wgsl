// Pass 2：流函数雅可比迭代 ∇²ψ = -ω（欠松弛 0.6，极区 sin 钳制）。
// 对应 TS ReferenceFilm.solveStreamFunction。每次 dispatch 做一次迭代，
// 由 CPU 按 jacobiIterations 次数重复提交并交换纹理。
#include "./common.wgsl"

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let k = i32(gid.x);
  let j = i32(gid.y);
  if (k >= i32(U.nPhi) || j >= i32(U.nTheta)) { return; }
  let d = cellDims();
  let thetaC = (f32(j) + 0.5) * d.x;
  let s = safeSin(thetaC);
  let dTheta = d.x;
  let dPhi = d.y;
  let aT = 1.0 / (dTheta * dTheta);
  let aP = 1.0 / (dPhi * dPhi * s * s);
  let diag = 2.0 * (aT + aP);

  let psi = loadPsi(j, k);
  let psiN = loadPsi(j + 1, k);
  let psiS = loadPsi(j - 1, k);
  let psiE = loadPsi(j, k + 1);
  let psiW = loadPsi(j, k - 1);
  let omega = loadOmega(j, k);
  let cotTerm = (cos(thetaC) / s) / (2.0 * dTheta) * (psiN - psiS);
  let gs = (aT * (psiN + psiS) + aP * (psiE + psiW) + omega - cotTerm) / diag;
  let relax = 0.6;
  var v = psi + relax * (gs - psi);
  if (!isfinite(v)) { v = 0.0; }
  textureStore(psiOut, vec2<i32>(k, j), vec4<f32>(v, 0.0, 0.0, 1.0));
}
