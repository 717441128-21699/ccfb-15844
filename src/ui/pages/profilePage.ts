/** 膜厚剖面页：实时回读 GPU 膜厚纹理，绘制经向剖面、黑膜占比、色序标尺 */
import { getEngine } from '../../gpu/ExhibitEngine';
import { thicknessToSRGB } from '../../optics/interference';
import type { SoapRecipe } from '../../physics/formulas';

export async function mountProfilePage(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <div class="page">
      <div class="profile-wrap">
        <div class="profile-chart">
          <canvas id="chart-profile"></canvas>
          <div class="legend">
            <span><i style="background:#6db4ff"></i>膜厚 h(θ) 沿经线（北极顶→南极底）</span>
            <span><i style="background:#ffc46b"></i>黑膜阈值 h_black</span>
            <span><i style="background:#5fd39a"></i>初始膜厚 h₀</span>
          </div>
        </div>
        <div class="profile-chart" style="max-width:420px">
          <canvas id="chart-scale"></canvas>
          <div class="legend"><span>牛顿色序标尺：颜色 = 当前配方在各膜厚下的干涉色（正视）</span></div>
          <div class="side-panel" style="position:static;width:auto;margin-top:14px;padding:16px">
            <h3>剖面读数</h3>
            <div class="kv" id="readout"></div>
          </div>
        </div>
      </div>
    </div>`;

  // WebGPU 引擎需要一个有真实尺寸的画布，并保持 present 心跳，
  // 否则 SwiftShader/部分驱动下"只 compute 不渲染 + 纹理回读"会触发设备崩溃。
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  canvas.style.cssText = 'position:absolute;width:256px;height:256px;opacity:0;pointer-events:none;';
  root.querySelector('.page')!.appendChild(canvas);
  const engine = await getEngine(canvas);
  if (engine.manager.count === 0) {
    engine.manager.blow([0, 0, 0], 0.5);
  }
  // 驱动仿真并保持交换链 present（渲染到隐藏画布，成本极低）
  let stopped = false;
  let lastTs = performance.now();
  let lastDraw = 0;
  let drawing = false;
  const frame = async (ts: number) => {
    if (stopped) return;
    const dt = Math.min(0.05, (ts - lastTs) / 1000);
    lastTs = ts;
    engine.manager.step(dt, engine.interaction);
    const aspect = canvas.width / Math.max(1, canvas.height);
    const { invViewProj } = engine.cameraMatrices(aspect);
    engine.renderer.render(engine.manager.views(), invViewProj, engine.cameraPos);
    // 每 2 秒回读一次纹理，上一次未完成则跳过（防止 MAP_READ 缓冲堆积）
    if (!drawing && ts - lastDraw > 2000) {
      drawing = true;
      lastDraw = ts;
      try {
        await draw();
        if (!stopped) drawScale(engine.recipe);
      } finally {
        drawing = false;
      }
    }
    requestAnimationFrame(frame);
  };
  const cleanup = () => { stopped = true; };
  window.addEventListener('hashchange', cleanup, { once: true });
  const profileCanvas = root.querySelector<HTMLCanvasElement>('#chart-profile')!;
  const scaleCanvas = root.querySelector<HTMLCanvasElement>('#chart-scale')!;
  const readout = root.querySelector<HTMLElement>('#readout')!;

  const drawScale = (recipe: SoapRecipe) => {
    const ctx = scaleCanvas.getContext('2d')!;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = scaleCanvas.clientWidth * dpr;
    const h = 90 * dpr;
    scaleCanvas.width = w; scaleCanvas.height = h;
    const hMax = recipe.initialThickness * 1.4;
    const bins = 300;
    for (let i = 0; i < bins; i++) {
      const hv = (i / bins) * hMax;
      const c = thicknessToSRGB(recipe, hv, 0);
      ctx.fillStyle = `rgb(${c.r * 255 | 0},${c.g * 255 | 0},${c.b * 255 | 0})`;
      ctx.fillRect((i / bins) * w, 0, w / bins + 1, h * 0.55);
    }
    // 厚度刻度
    ctx.fillStyle = '#93a1bd';
    ctx.font = `${11 * dpr}px sans-serif`;
    for (let i = 0; i <= 7; i++) {
      const hv = (i / 7) * hMax;
      const x = (i / 7) * w;
      ctx.fillText(`${(hv * 1e9).toFixed(0)}nm`, x, h * 0.72);
    }
    ctx.fillStyle = '#e8eefc';
    ctx.font = `${13 * dpr}px sans-serif`;
    ctx.fillText('膜厚 →', 8, h * 0.95);
  };

  const draw = async () => {
    const sim = engine.manager.views()[0]?.sim;
    if (!sim) return;
    const h = await sim.readThickness();
    const recipe = engine.recipe;
    const ctx = profileCanvas.getContext('2d')!;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const W = profileCanvas.clientWidth * dpr;
    const H = profileCanvas.clientHeight * dpr;
    if (profileCanvas.width !== W) { profileCanvas.width = W; profileCanvas.height = H; }
    ctx.clearRect(0, 0, W, H);

    // 经线平均（绕经度平均，抑制漩涡的周向差异，展示宏观排液趋势）
    const nTheta = sim.nTheta;
    const nPhi = sim.nPhi;
    const profile = new Float32Array(nTheta);
    for (let j = 0; j < nTheta; j++) {
      let s = 0;
      for (let k = 0; k < nPhi; k++) s += h[j * nPhi + k];
      profile[j] = s / nPhi;
    }
    const hMax = recipe.initialThickness * 1.6;
    const pad = { l: 64 * dpr, r: 20 * dpr, t: 24 * dpr, b: 44 * dpr };
    const plotW = W - pad.l - pad.r;
    const plotH = H - pad.t - pad.b;
    const xOf = (j: number) => pad.l + (j / (nTheta - 1)) * plotW;
    const yOf = (hv: number) => pad.t + plotH * (1 - Math.min(1, hv / hMax));

    // 网格与坐标轴
    ctx.strokeStyle = 'rgba(255,255,255,.08)';
    ctx.fillStyle = '#93a1bd';
    ctx.font = `${11 * dpr}px sans-serif`;
    ctx.lineWidth = dpr;
    for (let i = 0; i <= 5; i++) {
      const hv = (i / 5) * hMax;
      const y = yOf(hv);
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
      ctx.fillText(`${(hv * 1e9).toFixed(0)} nm`, 8, y + 4);
    }
    ctx.fillText('膜厚', 8, pad.t - 8);
    ctx.fillText('北极（顶）', pad.l, H - 12 * dpr);
    ctx.fillText('南极（底）', W - pad.r - 60 * dpr, H - 12 * dpr);

    // 参考线
    const line = (hv: number, color: string, label: string) => {
      ctx.strokeStyle = color; ctx.setLineDash([6 * dpr, 5 * dpr]);
      ctx.beginPath(); ctx.moveTo(pad.l, yOf(hv)); ctx.lineTo(W - pad.r, yOf(hv)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color; ctx.fillText(label, W - pad.r - 130 * dpr, yOf(hv) - 5 * dpr);
    };
    line(recipe.hBlack, '#ffc46b', `黑膜 ${(recipe.hBlack * 1e9).toFixed(0)}nm`);
    line(recipe.initialThickness, '#5fd39a', `初始 h₀ ${(recipe.initialThickness * 1e9).toFixed(0)}nm`);

    // 膜厚曲线
    ctx.strokeStyle = '#6db4ff'; ctx.lineWidth = 2.5 * dpr;
    ctx.beginPath();
    profile.forEach((hv, j) => {
      const x = xOf(j), y = yOf(hv);
      j === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();

    // 数据点按该处真实干涉色着色
    for (let j = 0; j < nTheta; j++) {
      const c = thicknessToSRGB(recipe, profile[j], 0);
      ctx.fillStyle = `rgb(${c.r * 255 | 0},${c.g * 255 | 0},${c.b * 255 | 0})`;
      ctx.beginPath(); ctx.arc(xOf(j), yOf(profile[j]), 3.5 * dpr, 0, Math.PI * 2); ctx.fill();
    }

    // 读数
    const top = profile[0];
    const bottom = profile[nTheta - 1];
    let blackCount = 0;
    for (const v of h) if (v < recipe.hBlack) blackCount++;
    const blackFrac = blackCount / h.length;
    readout.innerHTML = `
      <span>顶部膜厚</span><span>${(top * 1e9).toFixed(1)} nm</span>
      <span>底部膜厚</span><span>${(bottom * 1e9).toFixed(1)} nm</span>
      <span>顶/底比值</span><span>${(top / bottom).toFixed(3)}</span>
      <span>黑膜面积占比</span><span>${(blackFrac * 100).toFixed(2)} %</span>
      <span>破裂阈值</span><span>${(recipe.popBlackFraction * 100).toFixed(0)} %</span>
      <span>仿真时间</span><span>${sim.simTime.toFixed(1)} s（×${engine.simParams.timeScale}）</span>`;
  };

  drawScale(engine.recipe);
  requestAnimationFrame(frame);
}
