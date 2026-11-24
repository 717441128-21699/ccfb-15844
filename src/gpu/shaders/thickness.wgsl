// Pass 3：有限体积膜厚更新 + 手势交互 + 南极 Plateau 排流 + 物理上下限。
// 对应 TS ReferenceFilm.updateThickness。
#include "./common.wgsl"

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let k = i32(gid.x);
  let j = i32(gid.y);
  if (k >= i32(U.nPhi) || j >= i32(U.nTheta)) { return; }
  let d = cellDims();
  let dTheta = d.x;
  let dPhi = d.y;
  let r = U.radius;
  let thetaC = (f32(j) + 0.5) * dTheta;
  let thetaN = (f32(j) + 1.0) * dTheta;
  let thetaS = f32(j) * dTheta;
  let nt = i32(U.nTheta);

  let h = loadH(j, k);
  let hN = 0.5 * (h + loadH(min(j + 1, nt - 1), k));
  let hS = 0.5 * (h + loadH(max(j - 1, 0), k));
  let hE = 0.5 * (h + loadH(j, k + 1));
  let hW = 0.5 * (h + loadH(j, k - 1));

  let dSdTN = (loadSigma(min(j + 1, nt - 1), k) - loadSigma(j, k)) / dTheta;
  let dSdTS = (loadSigma(j, k) - loadSigma(max(j - 1, 0), k)) / dTheta;
  let dSdPE = (loadSigma(j, k + 1) - loadSigma(j, k)) / dPhi;
  let dSdPW = (loadSigma(j, k) - loadSigma(j, k - 1)) / dPhi;

  let fN = faceFluxTheta(hN, thetaN, dSdTN);
  let fS = faceFluxTheta(hS, thetaS, dSdTS);
  let fE = faceFluxPhi(hE, thetaC, dSdPE);
  let fW = faceFluxPhi(hW, thetaC, dSdPW);

  // 旋涡速度：uθ = (1/(R sinθ)) ∂ψ/∂φ，uφ = -(1/R) ∂ψ/∂θ
  let fl = sinFloor();
  let uThetaN = (loadPsi(min(j + 1, nt - 1), k) - loadPsi(j, k))
    / (r * max(sin(thetaN), fl) * dPhi);
  let uThetaS = (loadPsi(j, k) - loadPsi(max(j - 1, 0), k))
    / (r * max(sin(thetaS), fl) * dPhi);
  let uPhiE = -(loadPsi(j, k + 1) - loadPsi(j, k)) / (r * dTheta);
  let uPhiW = -(loadPsi(j, k) - loadPsi(j, k - 1)) / (r * dTheta);

  let sinN = sin(thetaN); // 北极面 sin(0)=0，自然零通量
  let sinS = sin(thetaS);
  let sinC = safeSin(thetaC);
  let qOut = dPhi * r * (sinN * (fN + hN * uThetaN) - sinS * (fS + hS * uThetaS))
    + dTheta * r * sinC * ((fE + hE * uPhiE) - (fW + hW * uPhiW));
  let area = r * r * sinC * dTheta * dPhi;

  var hNew = h - U.dt / area * qOut - U.evaporationRate * U.dt;

  // 南极 Plateau 边界：向储液槽指数松弛排流
  if (j == nt - 1) {
    let uDrain = U.density * U.gravity * h * h / (3.0 * U.viscosity) + 1e-12;
    let drainTau = (r * dTheta) / uDrain;
    hNew = hNew - U.dt * (h - U.hInitial) / drainTau;
  }

  // ---- 手势交互（球面角距离高斯核）----
  if (U.interactionMode != 0u) {
    let phiC = (f32(k) + 0.5) * dPhi;
    let dPhiWrap = atan2(sin(phiC - U.interactionPhi), cos(phiC - U.interactionPhi));
    let angDist = acos(clamp(
      cos(thetaC) * cos(U.interactionTheta)
        + sin(thetaC) * sin(U.interactionTheta) * cos(dPhiWrap),
      -1.0, 1.0));
    let w = exp(-(angDist * angDist) / (2.0 * U.interactionRadius * U.interactionRadius));
    switch U.interactionMode {
      case 1u: { // 吹：局部补充液体 + 扰动 Γ（形成新的色环流动）
        hNew = hNew + U.dt * U.interactionStrength * w * U.hInitial * 2.0;
      }
      case 2u: { // 戳：局部强制快速减薄到黑膜
        hNew = hNew - U.dt * U.interactionStrength * w * h * 8.0;
      }
      case 3u: { // 吹气：经向推动（等效局部重力增强）
        hNew = hNew - U.dt * U.interactionStrength * w * h * 2.0 * max(sin(thetaC), 0.0);
      }
      default: {}
    }
  }

  if (!isfinite(hNew)) { hNew = h; }
  hNew = clamp(hNew, U.hBlack * 0.1, U.hMaxCap);
  textureStore(hOut, vec2<i32>(k, j), vec4<f32>(hNew, 0.0, 0.0, 1.0));
}
