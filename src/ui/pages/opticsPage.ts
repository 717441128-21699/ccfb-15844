/** 干涉原理讲解页：纯 Canvas2D 可视化，不依赖 WebGPU（无 GPU 设备也能看） */
import { thicknessToSRGB, spectralReflectance, refractiveIndex } from '../../optics/interference';
import { getRecipe, RECIPES } from '../../physics/formulas';

export function mountOpticsPage(root: HTMLElement): void {
  root.innerHTML = `
    <div class="page">
      <div class="optics-wrap">
        <div class="optics-grid">
          <div class="card">
            <h3>① 两束反射光的相位差从哪里来</h3>
            <p>光照到肥皂膜时，在<b>膜的上表面</b>和<b>下表面</b>各反射一次。两束反射光走过的路程不同，
            光程差为 2nh·cosθ₂；膜越厚、光在膜里走得越斜，相位差越大。</p>
            <div class="formula">δ = 4π n h cosθ₂ / λ</div>
            <canvas id="cv-ray" height="260"></canvas>
            <p>两侧都是空气，两个界面的反射相移相同（相互抵消），所以当膜薄到 h→0 时两束光
            <b>相位相同却振幅相消</b>，反射光消失——这就是黑膜的由来。</p>
          </div>

          <div class="card">
            <h3>② 牛顿色序：膜厚增加时颜色按固定次序循环</h3>
            <p>每种波长在 δ=2π 整数倍时相消、奇数倍时相长。膜厚增加，各波长轮流达到反射极大，
            颜色就按 <b>黑→灰→黄→橙→红→紫→蓝→青→绿</b> 循环，级数越高颜色越淡（多波长重叠趋于白）。</p>
            <canvas id="cv-newton" height="200"></canvas>
            <div class="legend"><span id="newton-labels"></span></div>
          </div>

          <div class="card">
            <h3>③ 同一厚度，换个角度颜色也会变</h3>
            <p>斜入射时 cosθ₂ 变小，等效光程差缩短，相当于膜"变薄"，颜色向低级数方向漂移。
            拖动滑块改变入射角，观察色块变化。</p>
            <div class="field">
              <label>入射角 θI <b id="v-angle">0°</b></label>
              <input type="range" id="r-angle" min="0" max="70" step="1" value="0" />
            </div>
            <canvas id="cv-angle" height="180"></canvas>
          </div>

          <div class="card">
            <h3>④ 单波长反射率随膜厚周期振荡</h3>
            <p>选定波长后，反射率随膜厚呈周期振荡，周期为 λ/(2n)。三条曲线分别对应红、绿、蓝，
            它们的峰位错开，正是彩色干涉的来源。</p>
            <canvas id="cv-curve" height="240"></canvas>
            <div class="legend">
              <span><i style="background:#ff6b6b"></i>650nm 红</span>
              <span><i style="background:#5fd39a"></i>550nm 绿</span>
              <span><i style="background:#6db4ff"></i>450nm 蓝</span>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  const recipe = getRecipe('glycerol');
  drawRayDiagram(root.querySelector<HTMLCanvasElement>('#cv-ray')!);
  drawNewtonScale(root.querySelector<HTMLCanvasElement>('#cv-newton')!, recipe);
  const angleCanvas = root.querySelector<HTMLCanvasElement>('#cv-angle')!;
  const rAngle = root.querySelector<HTMLInputElement>('#r-angle')!;
  const drawAngle = () => {
    const deg = Number(rAngle.value);
    root.querySelector<HTMLElement>('#v-angle')!.textContent = `${deg}°`;
    drawAngleSwatch(angleCanvas, recipe, (deg * Math.PI) / 180);
  };
  rAngle.addEventListener('input', drawAngle);
  drawAngle();
  drawReflectanceCurve(root.querySelector<HTMLCanvasElement>('#cv-curve')!, recipe);
  void RECIPES;
}

function setup(canvas: HTMLCanvasElement): [CanvasRenderingContext2D, number, number] {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = canvas.clientWidth || canvas.parentElement!.clientWidth - 44;
  const h = Number(canvas.height) || 200;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  return [ctx, w, h];
}

function drawRayDiagram(canvas: HTMLCanvasElement): void {
  const [ctx, w, h] = setup(canvas);
  // 膜层
  const top = h * 0.32, bottom = h * 0.62, x0 = w * 0.18, x1 = w * 0.82;
  ctx.fillStyle = 'rgba(109,180,255,.12)';
  ctx.fillRect(x0, top, x1 - x0, bottom - top);
  ctx.strokeStyle = 'rgba(180,141,255,.7)'; ctx.lineWidth = 1.5;
  ctx.strokeRect(x0, top, x1 - x0, bottom - top);
  ctx.fillStyle = '#93a1bd'; ctx.font = '12px sans-serif';
  ctx.fillText('空气', x0 + 8, top - 8);
  ctx.fillText('肥皂膜 n≈1.35', x0 + 8, (top + bottom) / 2 + 4);
  ctx.fillText('空气', x0 + 8, bottom + 18);

  // 入射、折射、两束反射
  const ix = w * 0.32;
  ctx.strokeStyle = '#ffd479'; ctx.lineWidth = 2;
  drawArrow(ctx, ix - 50, top - 60, ix, top);
  ctx.fillStyle = '#ffd479'; ctx.fillText('入射光', ix - 78, top - 66);
  // 折射
  ctx.strokeStyle = '#6db4ff';
  drawArrow(ctx, ix, top, ix + 26, bottom);
  // 下表面反射
  drawArrow(ctx, ix + 26, bottom, ix + 52, top);
  // 上表面直接反射
  ctx.strokeStyle = '#ff8f8f';
  drawArrow(ctx, ix, top, ix - 40, top - 52);
  ctx.fillStyle = '#ff8f8f'; ctx.fillText('上表面反射①', ix - 110, top - 30);
  // 穿出的第二束
  ctx.strokeStyle = '#b48dff';
  drawArrow(ctx, ix + 52, top, ix + 12, top - 52);
  ctx.fillStyle = '#b48dff'; ctx.fillText('下表面反射②（多走 2nh·cosθ₂）', ix + 18, top - 30);
  // 相位差标注
  ctx.fillStyle = '#e8eefc'; ctx.font = '13px sans-serif';
  ctx.fillText('①② 两束光叠加：δ = 4πnhcosθ₂/λ', w * 0.42, h - 16);
}

function drawNewtonScale(canvas: HTMLCanvasElement, recipe: ReturnType<typeof getRecipe>): void {
  const [ctx, w, h] = setup(canvas);
  const hMax = 1.0e-6;
  const bins = 400;
  for (let i = 0; i < bins; i++) {
    const hv = (i / bins) * hMax;
    const c = thicknessToSRGB(recipe, hv, 0);
    ctx.fillStyle = `rgb(${c.r * 255 | 0},${c.g * 255 | 0},${c.b * 255 | 0})`;
    ctx.fillRect((i / bins) * w, 10, w / bins + 1, h * 0.5);
  }
  ctx.fillStyle = '#93a1bd'; ctx.font = '11px sans-serif';
  for (let i = 0; i <= 10; i++) {
    const nm = (i / 10) * hMax * 1e9;
    ctx.fillText(`${nm.toFixed(0)}`, (i / 10) * w - 8, h * 0.5 + 28);
  }
  ctx.fillStyle = '#e8eefc';
  ctx.fillText('膜厚 nm →', 8, h - 8);
  const el = document.querySelector('#newton-labels');
  if (el) el.textContent = '黑膜(<30nm) → 银灰 → 黄 → 红 → 紫蓝 → 青绿 → 二级循环（色渐变淡）';
}

function drawAngleSwatch(canvas: HTMLCanvasElement, recipe: ReturnType<typeof getRecipe>, theta: number): void {
  const [ctx, w, h] = setup(canvas);
  const hMax = 0.8e-6;
  const bins = 240;
  for (let i = 0; i < bins; i++) {
    const hv = (i / bins) * hMax;
    const c = thicknessToSRGB(recipe, hv, theta);
    ctx.fillStyle = `rgb(${c.r * 255 | 0},${c.g * 255 | 0},${c.b * 255 | 0})`;
    ctx.fillRect((i / bins) * w, 20, w / bins + 1, h - 40);
  }
  ctx.fillStyle = '#93a1bd'; ctx.font = '12px sans-serif';
  ctx.fillText(`入射角 ${(theta * 180 / Math.PI).toFixed(0)}° 下的干涉色（随膜厚）`, 8, 14);
}

function drawReflectanceCurve(canvas: HTMLCanvasElement, recipe: ReturnType<typeof getRecipe>): void {
  const [ctx, w, h] = setup(canvas);
  const pad = { l: 48, r: 16, t: 16, b: 36 };
  const plotW = w - pad.l - pad.r, plotH = h - pad.t - pad.b;
  const hMax = 1.2e-6;
  const waves: [number, string][] = [[650, '#ff6b6b'], [550, '#5fd39a'], [450, '#6db4ff']];
  ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.font = '11px sans-serif';
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (i / 4) * plotH;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillStyle = '#93a1bd';
    ctx.fillText(`${(0.1 - i * 0.025).toFixed(3)}`, 6, y + 4);
  }
  for (const [lambda, color] of waves) {
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
    for (let i = 0; i <= 300; i++) {
      const hv = (i / 300) * hMax;
      const r = spectralReflectance(recipe, hv, lambda, 0);
      const x = pad.l + (i / 300) * plotW;
      const y = pad.t + plotH * (1 - r / 0.1);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillText(`${lambda}nm`, w - pad.r - 48, pad.t + (waves.findIndex((q) => q[0] === lambda) * 16) + 12);
  }
  ctx.fillStyle = '#93a1bd';
  ctx.fillText('膜厚 nm →', pad.l + plotW - 70, h - 8);
  for (let i = 0; i <= 6; i++) {
    ctx.fillText(`${((i / 6) * hMax * 1e9).toFixed(0)}`, pad.l + (i / 6) * plotW - 10, h - 22);
  }
  void refractiveIndex;
}

function drawArrow(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  const ang = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - 9 * Math.cos(ang - 0.4), y2 - 9 * Math.sin(ang - 0.4));
  ctx.lineTo(x2 - 9 * Math.cos(ang + 0.4), y2 - 9 * Math.sin(ang + 0.4));
  ctx.closePath(); ctx.fill();
}
