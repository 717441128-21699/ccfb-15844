/**
 * 展项共享引擎：WebGPU 设备、LUT、渲染器、泡泡管理器的单例容器，
 * 以及帧循环与 FPS 统计。四个页面共用同一套 GPU 资源。
 */
import { initWebGPU, type GpuContext } from './context';
import { InterferenceLUT, DEFAULT_LUT_SPEC } from './InterferenceLUT';
import { BubbleRenderer } from './BubbleRenderer';
import { BubbleManager } from './BubbleManager';
import { RECIPES, getRecipe, type SoapRecipe } from '../physics/formulas';
import { DEFAULT_PARAMS, type SimParams } from '../physics/reference';
import { mat4Invert, mat4LookAt, mat4Multiply, mat4Perspective, type Mat4, type Vec3 } from './mat4';
import type { Interaction } from './FilmSimulatorGpu';

export class ExhibitEngine {
  gpu!: GpuContext;
  lut!: InterferenceLUT;
  renderer!: BubbleRenderer;
  manager!: BubbleManager;
  simParams: SimParams = { ...DEFAULT_PARAMS };
  recipe: SoapRecipe = RECIPES[1]; // 默认甘油长寿配方
  cameraPos: Vec3 = [0, 0.6, 3.2];
  cameraTarget: Vec3 = [0, 0, 0];
  private raf = 0;
  private lastTs = 0;
  private fpsSamples: number[] = [];
  private fpsCb: ((fps: number) => void) | null = null;
  private pendingInteraction: Interaction = {
    mode: 0, theta: 0, phi: 0, strength: 0, radius: 0.25,
  };

  async init(canvas: HTMLCanvasElement): Promise<void> {
    this.gpu = await initWebGPU(canvas);
    this.lut = new InterferenceLUT(this.gpu.device, this.recipe, DEFAULT_LUT_SPEC);
    this.renderer = new BubbleRenderer(
      this.gpu.device, this.gpu.context, this.gpu.format, this.lut,
    );
    this.manager = new BubbleManager(this.gpu.device, this.recipe, this.simParams);
    // 全局钩子：自动化测试与现场诊断用
    (globalThis as Record<string, unknown>).__engine = this;
  }

  setRecipe(id: string): void {
    this.recipe = getRecipe(id);
    this.lut.rebuild(this.recipe);
    this.manager.setRecipe(this.recipe);
  }

  setInteraction(i: Interaction): void {
    this.pendingInteraction = i;
  }

  onFps(cb: (fps: number) => void): void {
    this.fpsCb = cb;
  }

  /** 计算当前相机矩阵与逆 VP（供射线反算与渲染共用） */
  cameraMatrices(aspect: number): { viewProj: Mat4; invViewProj: Mat4 } {
    const proj = mat4Perspective((50 * Math.PI) / 180, aspect, 0.05, 50);
    const view = mat4LookAt(this.cameraPos, this.cameraTarget, [0, 1, 0]);
    const viewProj = mat4Multiply(proj, view);
    return { viewProj, invViewProj: mat4Invert(viewProj) };
  }

  /** 屏幕归一化坐标 (0..1) -> 世界射线 */
  screenToRay(nx: number, ny: number, aspect: number): { origin: Vec3; dir: Vec3 } {
    const { invViewProj } = this.cameraMatrices(aspect);
    const ndcX = nx * 2 - 1;
    const ndcY = 1 - ny * 2;
    const unproject = (z: number): Vec3 => {
      const v = new Float32Array([ndcX, ndcY, z, 1]);
      const out = new Float32Array(4);
      for (let r = 0; r < 4; r++) {
        out[r] =
          invViewProj[r] * v[0] +
          invViewProj[4 + r] * v[1] +
          invViewProj[8 + r] * v[2] +
          invViewProj[12 + r] * v[3];
      }
      return [out[0] / out[3], out[1] / out[3], out[2] / out[3]];
    };
    const near = unproject(0);
    const far = unproject(1);
    const dx = far[0] - near[0];
    const dy = far[1] - near[1];
    const dz = far[2] - near[2];
    const l = Math.hypot(dx, dy, dz);
    return { origin: near, dir: [dx / l, dy / l, dz / l] };
  }

  startLoop(canvas: HTMLCanvasElement, frame: (dt: number) => void | Promise<void>): void {
    this.lastTs = performance.now();
    const tick = async (ts: number) => {
      const dt = Math.min(0.05, (ts - this.lastTs) / 1000);
      this.lastTs = ts;
      await frame(dt);
      this.fpsSamples.push(1 / Math.max(dt, 1e-4));
      if (this.fpsSamples.length > 40) this.fpsSamples.shift();
      if (this.fpsCb && this.fpsSamples.length === 40) {
        const avg = this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length;
        this.fpsCb(avg);
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    void canvas;
  }

  stopLoop(): void {
    cancelAnimationFrame(this.raf);
  }

  get interaction(): Interaction {
    return this.pendingInteraction;
  }

  destroy(): void {
    this.stopLoop();
    this.manager?.destroy();
    this.lut?.destroy();
  }
}

/** 全局单例（页面切换不重建 GPU 资源） */
let engine: ExhibitEngine | null = null;
export async function getEngine(canvas: HTMLCanvasElement): Promise<ExhibitEngine> {
  if (!engine) {
    engine = new ExhibitEngine();
    await engine.init(canvas);
  } else if (!engine.gpu) {
    await engine.init(canvas);
  }
  return engine;
}
export function existingEngine(): ExhibitEngine | null {
  return engine;
}
