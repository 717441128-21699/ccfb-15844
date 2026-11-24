/** 吹泡展示页：4K 大屏主场景，六泡互动 */
import { getEngine } from '../../gpu/ExhibitEngine';
import { GestureInput, type GestureEvent } from '../../interaction/GestureInput';
import { BubbleManager } from '../../gpu/BubbleManager';
import type { Vec3 } from '../../gpu/mat4';
import type { Interaction } from '../../gpu/FilmSimulatorGpu';

const BUBBLE_SLOTS: Vec3[] = [
  [-1.5, 0.7, 0],
  [0, 1.0, -0.3],
  [1.5, 0.7, 0],
  [-0.9, -0.7, 0.2],
  [0.9, -0.7, 0.2],
  [0, -0.2, 0.8],
];

export async function mountShowPage(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <div class="page">
      <canvas id="stage" style="position:absolute;inset:0;width:100%;height:100%"></canvas>
      <video id="cam" class="cam-preview off" playsinline muted></video>
      <div class="side-panel">
        <h3>互动控制</h3>
        <button class="btn" id="btn-blow">吹一个泡泡</button>
        <button class="btn secondary" id="btn-blow6">一次吹满六个</button>
        <button class="btn secondary" id="btn-cam">开启摄像头手势</button>
        <div class="field">
          <label>时间加速 <b id="v-timescale">--</b></label>
          <input type="range" id="r-timescale" min="5" max="120" step="1" />
        </div>
        <div class="field">
          <label>手势作用半径 <b id="v-radius">--</b></label>
          <input type="range" id="r-radius" min="0.05" max="0.6" step="0.01" />
        </div>
        <div class="status-line"><span class="dot"></span>当前泡泡：<b id="v-count">0</b> / 6</div>
        <div class="status-line" id="v-gesture">手势：等待输入</div>
      </div>
      <div class="hint">
        <b>操作方式</b><br/>
        鼠标 <span class="kbd">左键</span> 戳泡　<span class="kbd">Shift+左键</span> 吹泡　<span class="kbd">右键</span> 吹气<br/>
        摄像头手势：食指戳泡 · 张掌吹气 · 捏合后张开吹泡
      </div>
    </div>`;

  const canvas = root.querySelector<HTMLCanvasElement>('#stage')!;
  resizeToDisplay(canvas);
  const engine = await getEngine(canvas);
  const { device } = engine.gpu;

  const rTime = root.querySelector<HTMLInputElement>('#r-timescale')!;
  const rRadius = root.querySelector<HTMLInputElement>('#r-radius')!;
  rTime.value = String(engine.simParams.timeScale);
  rRadius.value = '0.25';
  root.querySelector<HTMLElement>('#v-timescale')!.textContent = `${rTime.value}×`;
  root.querySelector<HTMLElement>('#v-radius')!.textContent = rRadius.value;

  let interactionRadius = 0.25;
  const setGestureText = (t: string) => {
    root.querySelector<HTMLElement>('#v-gesture')!.textContent = `手势：${t}`;
  };

  const blowOne = () => {
    const idx = engine.manager.count % 6;
    engine.manager.blow(BUBBLE_SLOTS[idx], 0.42 + Math.random() * 0.12);
    root.querySelector<HTMLElement>('#v-count')!.textContent = String(engine.manager.count);
  };
  root.querySelector('#btn-blow')!.addEventListener('click', blowOne);
  root.querySelector('#btn-blow6')!.addEventListener('click', () => {
    for (let i = 0; i < 6; i++) {
      engine.manager.blow(BUBBLE_SLOTS[i], 0.42 + ((i * 37) % 5) * 0.025);
    }
    root.querySelector<HTMLElement>('#v-count')!.textContent = String(engine.manager.count);
  });

  rTime.addEventListener('input', () => {
    engine.simParams.timeScale = Number(rTime.value);
    root.querySelector<HTMLElement>('#v-timescale')!.textContent = `${rTime.value}×`;
  });
  rRadius.addEventListener('input', () => {
    interactionRadius = Number(rRadius.value);
    root.querySelector<HTMLElement>('#v-radius')!.textContent = rRadius.value;
  });

  // 手势 -> 引擎交互
  const onGesture = (e: GestureEvent) => {
    if (e.kind === 'none') {
      engine.setInteraction({ mode: 0, theta: 0, phi: 0, strength: 0, radius: interactionRadius });
      setGestureText('等待输入');
      return;
    }
    const aspect = canvas.clientWidth / canvas.clientHeight;
    const ray = engine.screenToRay(e.x, e.y, aspect);
    const target = engine.manager.pickBubble(ray.origin, ray.dir);
    const modeMap = { blow: 1, poke: 2, breath: 3 } as const;
    if (e.kind === 'blow' && (!target || e.source === 'pointer')) {
      // 空白处吹泡：在射线方向生成
      const center: Vec3 = [
        ray.origin[0] + ray.dir[0] * 2.2,
        ray.origin[1] + ray.dir[1] * 2.2,
        ray.origin[2] + ray.dir[2] * 2.2,
      ];
      engine.manager.blow(center, 0.45);
      root.querySelector<HTMLElement>('#v-count')!.textContent = String(engine.manager.count);
      setGestureText('吹泡');
      return;
    }
    if (target) {
      const hit = BubbleManager.screenRayToSpherical(
        ray.origin, ray.dir, target.center, target.radius,
      );
      if (hit) {
        const interaction: Interaction = {
          mode: modeMap[e.kind],
          theta: hit.theta,
          phi: hit.phi,
          strength: e.strength,
          radius: interactionRadius,
        };
        engine.setInteraction(interaction);
        setGestureText(
          e.kind === 'poke' ? '戳泡' : e.kind === 'breath' ? '吹气' : '吹泡扰动',
        );
        // 戳泡：立即标记破裂（破裂动画在管理器帧循环中推进）
        if (e.kind === 'poke') engine.manager.popAt(hit.point);
      }
    }
  };
  const gestures = new GestureInput(canvas, onGesture);

  // 摄像头
  const video = root.querySelector<HTMLVideoElement>('#cam')!;
  root.querySelector('#btn-cam')!.addEventListener('click', async () => {
    if (video.classList.contains('off')) {
      try {
        await gestures.startCamera(video);
        video.classList.remove('off');
      } catch (err) {
        setGestureText(`摄像头不可用：${err instanceof Error ? err.message : err}`);
      }
    } else {
      gestures.stopCamera();
      video.classList.add('off');
    }
  });

  let frameCount = 0;
  let lastPoll = 0;
  engine.onFps((fps) => {
    const badge = document.querySelector<HTMLDivElement>('#fps-badge')!;
    badge.hidden = false;
    badge.textContent = `${fps.toFixed(0)} fps · 6 泡 · WebGPU`;
    badge.classList.toggle('low', fps < 55);
  });

  engine.startLoop(canvas, (dt) => {
    resizeToDisplay(canvas);
    engine.manager.step(dt, engine.interaction);
    // 黑膜破裂判定：每 ~500ms 异步轮询一个泡泡，不阻塞渲染
    lastPoll += dt;
    if (lastPoll >= 0.5) {
      lastPoll = 0;
      void engine.manager.pollBlackFraction();
    }
    // 交互是瞬时脉冲，每帧末尾衰减
    if (engine.interaction.mode !== 0) {
      engine.setInteraction({ ...engine.interaction, strength: engine.interaction.strength * 0.7 });
    }
    const aspect = canvas.width / canvas.height;
    const { invViewProj } = engine.cameraMatrices(aspect);
    engine.renderer.render(engine.manager.views(), invViewProj, engine.cameraPos);
    frameCount++;
    if (frameCount % 15 === 0) {
      root.querySelector<HTMLElement>('#v-count')!.textContent = String(engine.manager.activeCount);
    }
  });

  // 初始自动吹两个，避免空场
  setTimeout(() => {
    if (engine.manager.count === 0) {
      engine.manager.blow(BUBBLE_SLOTS[1], 0.5);
      engine.manager.blow(BUBBLE_SLOTS[0], 0.44);
      root.querySelector<HTMLElement>('#v-count')!.textContent = String(engine.manager.count);
    }
  }, 300);

  void device;
}

function resizeToDisplay(canvas: HTMLCanvasElement): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.floor(canvas.clientWidth * dpr);
  const h = Math.floor(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}
