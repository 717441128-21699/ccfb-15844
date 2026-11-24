/**
 * 泡泡群管理器：最多 6 个泡泡的生命周期（吹泡 -> 排液 -> 黑膜 -> 破裂）。
 * 手势屏幕坐标先转世界射线，再求与泡泡球面的交点，得到交互用的 (θ, φ)。
 */
import type { SoapRecipe } from '../physics/formulas';
import { DEFAULT_PARAMS, type SimParams } from '../physics/reference';
import { FilmSimulatorGpu, type Interaction } from './FilmSimulatorGpu';
import type { BubbleView } from './BubbleRenderer';
import type { Vec3 } from './mat4';

interface ManagedBubble {
  sim: FilmSimulatorGpu;
  center: Vec3;
  radius: number;
  bornAt: number;
  popProgress: number;
  popping: boolean;
  wobble: number;
}

export class BubbleManager {
  readonly maxBubbles = 6;
  private device: GPUDevice;
  private recipe: SoapRecipe;
  private params: SimParams;
  private bubbles: ManagedBubble[] = [];
  private time = 0;

  constructor(device: GPUDevice, recipe: SoapRecipe, params: SimParams = DEFAULT_PARAMS) {
    this.device = device;
    this.recipe = recipe;
    this.params = { ...params, timeScale: recipe.defaultTimeScale };
  }

  get count(): number {
    return this.bubbles.length;
  }

  get activeCount(): number {
    return this.bubbles.filter((b) => !b.popping).length;
  }

  /** 吹一个新泡；已有 6 个时回收最老的 */
  blow(center: Vec3, radius: number): ManagedBubble {
    if (this.bubbles.length >= this.maxBubbles) {
      const oldest = this.bubbles.shift()!;
      oldest.sim.destroy();
    }
    const sim = new FilmSimulatorGpu(this.device, this.recipe, this.params);
    const bubble: ManagedBubble = {
      sim,
      center,
      radius,
      bornAt: this.time,
      popProgress: 0,
      popping: false,
      wobble: Math.random() * Math.PI * 2,
    };
    this.bubbles.push(bubble);
    return bubble;
  }

  /** 戳破指定泡泡（或按世界坐标命中的最近泡泡） */
  popAt(worldPoint: Vec3): boolean {
    let best: ManagedBubble | null = null;
    let bestD = Infinity;
    for (const b of this.bubbles) {
      if (b.popping) continue;
      const d = Math.hypot(
        worldPoint[0] - b.center[0],
        worldPoint[1] - b.center[1],
        worldPoint[2] - b.center[2],
      );
      if (d < b.radius && d < bestD) { best = b; bestD = d; }
    }
    if (best) { best.popping = true; return true; }
    return false;
  }

  /**
   * 推进所有泡泡仿真（同步，不阻塞帧循环）。
   * 黑膜破裂判定由 pollBlackFraction 按固定间隔异步进行，避免每帧 mapAsync 回读。
   */
  step(frameDt: number, interaction: Interaction): void {
    this.time += frameDt;
    const dead: ManagedBubble[] = [];
    for (const b of this.bubbles) {
      b.wobble += frameDt * 1.5;
      if (!b.popping) {
        b.sim.step(frameDt, interaction);
      } else {
        b.popProgress = Math.min(1, b.popProgress + frameDt * 1.8);
        if (b.popProgress >= 1) dead.push(b);
      }
    }
    for (const d of dead) {
      d.sim.destroy();
      this.bubbles = this.bubbles.filter((b) => b !== d);
    }
  }

  /**
   * 异步轮询所有在役泡泡的黑膜占比，超阈值则标记破裂。
   * 由外部按 ~500ms 间隔调用，单次最多回读一个泡泡，摊薄 GPU 回读开销。
   */
  async pollBlackFraction(): Promise<void> {
    const candidates = this.bubbles.filter((b) => !b.popping);
    if (candidates.length === 0) return;
    // 轮流检查，避免一次回读全部纹理
    this.pollIndex = (this.pollIndex + 1) % candidates.length;
    const target = candidates[this.pollIndex];
    const black = await target.sim.computeBlackFraction();
    if (black >= this.recipe.popBlackFraction) target.popping = true;
  }
  private pollIndex = 0;

  /** 供渲染器使用的视图 */
  views(): BubbleView[] {
    return this.bubbles.map((b) => ({
      center: b.center,
      radius: b.radius,
      popProgress: b.popProgress,
      wobble: b.wobble,
      sim: b.sim,
    }));
  }

  /**
   * 把世界射线命中的泡泡表面点转换为球面角 (θ, φ)。
   * θ 从北极(顶部)量起 0..π，φ 绕经度 0..2π。未命中返回 null。
   */
  static screenRayToSpherical(
    origin: Vec3,
    dir: Vec3,
    center: Vec3,
    radius: number,
  ): { theta: number; phi: number; point: Vec3 } | null {
    const ox = origin[0] - center[0];
    const oy = origin[1] - center[1];
    const oz = origin[2] - center[2];
    const b = ox * dir[0] + oy * dir[1] + oz * dir[2];
    const c = ox * ox + oy * oy + oz * oz - radius * radius;
    const disc = b * b - c;
    if (disc < 0) return null;
    const t = -b - Math.sqrt(disc);
    if (t < 0) return null;
    const point: Vec3 = [
      origin[0] + dir[0] * t,
      origin[1] + dir[1] * t,
      origin[2] + dir[2] * t,
    ];
    const nx = (point[0] - center[0]) / radius;
    const ny = (point[1] - center[1]) / radius;
    const nz = (point[2] - center[2]) / radius;
    const theta = Math.acos(Math.max(-1, Math.min(1, ny)));
    let phi = Math.atan2(nz, nx) + Math.PI;
    if (phi < 0) phi += 2 * Math.PI;
    return { theta, phi, point };
  }

  /** 找到射线命中的最近泡泡（手势目标选择） */
  pickBubble(origin: Vec3, dir: Vec3): ManagedBubble | null {
    let best: ManagedBubble | null = null;
    let bestT = Infinity;
    for (const b of this.bubbles) {
      if (b.popping) continue;
      const hit = BubbleManager.screenRayToSpherical(origin, dir, b.center, b.radius);
      if (hit) {
        const t = Math.hypot(
          hit.point[0] - origin[0], hit.point[1] - origin[1], hit.point[2] - origin[2],
        );
        if (t < bestT) { bestT = t; best = b; }
      }
    }
    return best;
  }

  get recipeSnapshot(): SoapRecipe {
    return this.recipe;
  }

  setRecipe(recipe: SoapRecipe): void {
    this.recipe = recipe;
    this.params = { ...this.params, timeScale: recipe.defaultTimeScale };
  }

  destroy(): void {
    for (const b of this.bubbles) b.sim.destroy();
    this.bubbles = [];
  }
}
