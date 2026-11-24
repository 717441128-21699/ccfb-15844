/** 展项参数页：四种肥皂液配方、物理与仿真参数、性能预算 */
import { RECIPES } from '../../physics/formulas';
import { DEFAULT_PARAMS } from '../../physics/reference';
import { existingEngine } from '../../gpu/ExhibitEngine';

export function mountParamsPage(root: HTMLElement): void {
  const engine = existingEngine();
  root.innerHTML = `
    <div class="page">
      <div class="params-wrap">
        <h2 style="width:100%;margin:4px 0 8px">肥皂液配方（点击切换，切换后新吹的泡泡生效）</h2>
        <div class="params-grid" id="recipe-grid"></div>

        <h2 style="width:100%;margin:18px 0 8px">仿真与展项参数</h2>
        <div class="params-grid">
          <div class="card">
            <h3>物理参数（当前配方）</h3>
            <div class="kv" id="physics-kv"></div>
          </div>
          <div class="card">
            <h3>仿真调节</h3>
            <div class="field">
              <label>时间加速倍率 <b id="v-ts">--</b></label>
              <input type="range" id="r-ts" min="5" max="150" step="1" />
            </div>
            <div class="field">
              <label>涡量斜压增益 <b id="v-bar">--</b></label>
              <input type="range" id="r-bar" min="0" max="20" step="0.5" />
            </div>
            <div class="field">
              <label>泡泡半径（米）<b id="v-rad">--</b></label>
              <input type="range" id="r-rad" min="0.15" max="0.6" step="0.01" />
            </div>
            <button class="btn" id="btn-reset">恢复默认仿真参数</button>
          </div>
          <div class="card">
            <h3>性能预算（4K@60fps 目标）</h3>
            <div class="kv">
              <span>同时泡泡数</span><span>6</span>
              <span>单泡网格</span><span>32 × 48 = 1536 单元</span>
              <span>每帧 GPU 子步</span><span>24</span>
              <span>Jacobi 迭代/子步</span><span>10</span>
              <span>干涉 LUT</span><span>256 × 64 RGBA32F</span>
              <span>光谱积分点</span><span>41 波长 × s/p 偏振</span>
              <span>渲染方式</span><span>全屏光线求交，无顶点缓冲</span>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  const grid = root.querySelector<HTMLElement>('#recipe-grid')!;
  const currentId = engine?.recipe.id ?? RECIPES[1].id;
  for (const r of RECIPES) {
    const card = document.createElement('div');
    card.className = `card recipe-card ${r.id === currentId ? 'selected' : ''}`;
    card.innerHTML = `
      <h4>${r.name}</h4>
      <div class="comp">${r.composition.map((c) => `${c.ingredient} ${c.massFraction}%`).join(' · ')}</div>
      <p style="font-size:13px;min-height:56px">${r.description}</p>
      <div class="kv">
        <span>黏度 μ</span><span>${r.viscosity.toExponential(2)} Pa·s</span>
        <span>表面张力 σ</span><span>${r.surfaceTension.toFixed(3)} N/m</span>
        <span>表面弹性 E_s</span><span>${r.surfaceElasticity.toFixed(3)} N/m</span>
        <span>初始膜厚</span><span>${(r.initialThickness * 1e9).toFixed(0)} nm</span>
        <span>黑膜厚度</span><span>${(r.hBlack * 1e9).toFixed(1)} nm</span>
        <span>破裂黑膜占比</span><span>${(r.popBlackFraction * 100).toFixed(0)}%</span>
        <span>蒸发率</span><span>${r.evaporationRate.toExponential(1)} m/s</span>
        <span>默认加速</span><span>${r.defaultTimeScale}×</span>
      </div>`;
    card.addEventListener('click', () => {
      engine?.setRecipe(r.id);
      grid.querySelectorAll('.recipe-card').forEach((el) => el.classList.remove('selected'));
      card.classList.add('selected');
      refreshPhysics();
    });
    grid.appendChild(card);
  }

  const physicsKv = root.querySelector<HTMLElement>('#physics-kv')!;
  const refreshPhysics = () => {
    const r = engine?.recipe ?? RECIPES[1];
    physicsKv.innerHTML = `
      <span>密度 ρ</span><span>${r.density} kg/m³</span>
      <span>黏度 μ</span><span>${r.viscosity.toExponential(2)} Pa·s</span>
      <span>表面张力 σ₀</span><span>${r.surfaceTension} N/m</span>
      <span>Cauchy A / B</span><span>${r.cauchyA} / ${r.cauchyB}</span>
      <span>灰膜厚度</span><span>${(r.hGray * 1e9).toFixed(1)} nm</span>
      <span>黑膜厚度</span><span>${(r.hBlack * 1e9).toFixed(1)} nm</span>`;
  };
  refreshPhysics();

  if (!engine) return;
  const rTs = root.querySelector<HTMLInputElement>('#r-ts')!;
  const rBar = root.querySelector<HTMLInputElement>('#r-bar')!;
  const rRad = root.querySelector<HTMLInputElement>('#r-rad')!;
  rTs.value = String(engine.simParams.timeScale);
  rBar.value = String(engine.simParams.baroclinicGain);
  rRad.value = String(engine.simParams.radius);
  const sync = () => {
    root.querySelector<HTMLElement>('#v-ts')!.textContent = `${rTs.value}×`;
    root.querySelector<HTMLElement>('#v-bar')!.textContent = rBar.value;
    root.querySelector<HTMLElement>('#v-rad')!.textContent = `${rRad.value} m`;
  };
  sync();
  rTs.addEventListener('input', () => { engine.simParams.timeScale = Number(rTs.value); sync(); });
  rBar.addEventListener('input', () => { engine.simParams.baroclinicGain = Number(rBar.value); sync(); });
  rRad.addEventListener('input', () => { engine.simParams.radius = Number(rRad.value); sync(); });
  root.querySelector('#btn-reset')!.addEventListener('click', () => {
    Object.assign(engine.simParams, DEFAULT_PARAMS, { timeScale: engine.recipe.defaultTimeScale });
    rTs.value = String(engine.simParams.timeScale);
    rBar.value = String(engine.simParams.baroclinicGain);
    rRad.value = String(engine.simParams.radius);
    sync();
  });
}
