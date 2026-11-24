/**
 * 单个泡泡的 WebGPU 膜厚仿真器。
 *
 * 膜厚 h、表面活性剂 Γ、涡量 ω、流函数 ψ 各占一张 RGBA32F 经纬网格纹理，
 * 三个计算 pass（平流注入 / Jacobi 迭代 / 膜厚更新）在 GPU 上完成，
 * 数学与 src/physics/reference.ts 逐式对应，由单元测试锁定参考结果。
 *
 * 稳定子步：每帧固定拆成 maxSubSteps 个子步（默认 24），
 * 等价于 TS 参考中"每子步相对变化 ≤5%"的预算控制，避免每帧 GPU 回读 CFL。
 */
import type { SoapRecipe } from '../physics/formulas';
import type { SimParams } from '../physics/reference';
import advectWgsl from './shaders/advect.wgsl?raw';
import jacobiWgsl from './shaders/jacobi.wgsl?raw';
import thicknessWgsl from './shaders/thickness.wgsl?raw';
import { createShaderModule } from './shaderLoader';

export interface Interaction {
  mode: 0 | 1 | 2 | 3;
  theta: number;
  phi: number;
  strength: number;
  radius: number;
}

export const NO_INTERACTION: Interaction = {
  mode: 0, theta: 0, phi: 0, strength: 0, radius: 0.2,
};

// 与 common.wgsl SimUniforms 内存布局对应（48 个 f32 槽 = 192 字节）
interface UniformData {
  nTheta: number;
  nPhi: number;
  radius: number;
  dt: number;
  viscosity: number;
  density: number;
  gravity: number;
  surfaceTension0: number;
  surfaceElasticity: number;
  evaporationRate: number;
  vorticityDiffusion: number;
  gammaDiffusion: number;
  baroclinicGain: number;
  jacobiIterations: number;
  hBlack: number;
  hInitial: number;
  hMaxCap: number;
  time: number;
  interactionMode: number;
  interactionTheta: number;
  interactionPhi: number;
  interactionStrength: number;
  interactionRadius: number;
  pad0: number;
  pad1: number;
}

const UNIFORM_FIELDS: (keyof UniformData)[] = [
  'nTheta', 'nPhi', 'radius', 'dt', 'viscosity', 'density', 'gravity',
  'surfaceTension0', 'surfaceElasticity', 'evaporationRate',
  'vorticityDiffusion', 'gammaDiffusion', 'baroclinicGain', 'jacobiIterations',
  'hBlack', 'hInitial', 'hMaxCap', 'time',
  'interactionMode', 'interactionTheta', 'interactionPhi', 'interactionStrength',
  'interactionRadius', 'pad0', 'pad1',
];
const U32_FIELDS = new Set(['nTheta', 'nPhi', 'jacobiIterations', 'interactionMode']);

interface TextureSet {
  h: GPUTexture;
  gamma: GPUTexture;
  omega: GPUTexture;
  psi: GPUTexture;
}

export class FilmSimulatorGpu {
  readonly nTheta: number;
  readonly nPhi: number;
  blackFraction = 0;
  simTime = 0;
  /** 每帧固定子步数：真实 GPU 上 8 步即可满足相对变化预算，6 泡 ×11 分发仍有充裕余量 */
  maxSubSteps = 8;

  private device: GPUDevice;
  private recipe: SoapRecipe;
  private params: SimParams;
  private front: TextureSet;
  private back: TextureSet;
  private uniformBuffer: GPUBuffer;
  private bindLayout: GPUBindGroupLayout;
  private advectPipeline: GPUComputePipeline;
  private jacobiPipeline: GPUComputePipeline;
  private thicknessPipeline: GPUComputePipeline;
  private workgroups: { x: number; y: number };

  constructor(
    device: GPUDevice,
    recipe: SoapRecipe,
    params: SimParams,
    nTheta = 32,
    nPhi = 48,
  ) {
    this.device = device;
    this.recipe = recipe;
    this.params = params;
    this.nTheta = nTheta;
    this.nPhi = nPhi;
    this.workgroups = { x: Math.ceil(nPhi / 8), y: Math.ceil(nTheta / 8) };

    this.front = this.createTextures('front');
    this.back = this.createTextures('back');
    this.uniformBuffer = device.createBuffer({
      size: 192,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'sim-uniforms',
    });

    // 显式完整布局：common.wgsl 声明了全部 0..8 绑定，
    // 各 pass 只写自己负责的 storage 纹理，未用的绑定在显式布局下合法。
    this.bindLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba32float' } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba32float' } },
        { binding: 7, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba32float' } },
        { binding: 8, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba32float' } },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.bindLayout] });
    this.advectPipeline = device.createComputePipeline({
      layout: pipelineLayout,
      compute: { module: createShaderModule(device, advectWgsl, 'advect'), entryPoint: 'main' },
    });
    this.jacobiPipeline = device.createComputePipeline({
      layout: pipelineLayout,
      compute: { module: createShaderModule(device, jacobiWgsl, 'jacobi'), entryPoint: 'main' },
    });
    this.thicknessPipeline = device.createComputePipeline({
      layout: pipelineLayout,
      compute: { module: createShaderModule(device, thicknessWgsl, 'thickness'), entryPoint: 'main' },
    });
    this.reset();
  }

  get currentHTexture(): GPUTexture {
    return this.front.h;
  }

  private createTextures(label: string): TextureSet {
    const size = { width: this.nPhi, height: this.nTheta };
    const mk = (name: string) =>
      this.device.createTexture({
        size,
        format: 'rgba32float',
        usage:
          GPUTextureUsage.STORAGE_BINDING |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.COPY_SRC,
        label: `${label}-${name}`,
      });
    return { h: mk('h'), gamma: mk('gamma'), omega: mk('omega'), psi: mk('psi') };
  }

  /** 按当前 front/back 构建绑定组（三条管线共用显式完整布局） */
  private bindGroupFor(_pipeline: GPUComputePipeline, src: TextureSet, dst: TextureSet): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.bindLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: src.h.createView() },
        { binding: 2, resource: src.gamma.createView() },
        { binding: 3, resource: src.omega.createView() },
        { binding: 4, resource: src.psi.createView() },
        { binding: 5, resource: dst.h.createView() },
        { binding: 6, resource: dst.gamma.createView() },
        { binding: 7, resource: dst.omega.createView() },
        { binding: 8, resource: dst.psi.createView() },
      ],
    });
  }

  reset(): void {
    const pixels = this.nTheta * this.nPhi;
    const hData = new Float32Array(pixels * 4);
    const gammaData = new Float32Array(pixels * 4);
    const zero = new Float32Array(pixels * 4);
    for (let i = 0; i < pixels; i++) {
      hData[i * 4] = this.recipe.initialThickness;
      hData[i * 4 + 3] = 1;
      gammaData[i * 4] = 0.5;
      gammaData[i * 4 + 3] = 1;
    }
    const layout = { bytesPerRow: this.nPhi * 16, rowsPerImage: this.nTheta };
    const size = { width: this.nPhi, height: this.nTheta };
    for (const set of [this.front, this.back]) {
      this.device.queue.writeTexture({ texture: set.h }, hData, layout, size);
      this.device.queue.writeTexture({ texture: set.gamma }, gammaData, layout, size);
      this.device.queue.writeTexture({ texture: set.omega }, zero, layout, size);
      this.device.queue.writeTexture({ texture: set.psi }, zero, layout, size);
    }
    this.simTime = 0;
    this.blackFraction = 0;
  }

  private writeUniforms(dt: number, interaction: Interaction): void {
    const data: UniformData = {
      nTheta: this.nTheta,
      nPhi: this.nPhi,
      radius: this.params.radius,
      dt,
      viscosity: this.recipe.viscosity,
      density: this.recipe.density,
      gravity: 9.81,
      surfaceTension0: this.recipe.surfaceTension,
      surfaceElasticity: this.recipe.surfaceElasticity,
      evaporationRate: this.recipe.evaporationRate,
      vorticityDiffusion: this.params.vorticityDiffusion,
      gammaDiffusion: this.params.gammaDiffusion,
      baroclinicGain: this.params.baroclinicGain,
      jacobiIterations: this.params.jacobiIterations,
      hBlack: this.recipe.hBlack,
      hInitial: this.recipe.initialThickness,
      hMaxCap: 25 * this.recipe.initialThickness,
      time: this.simTime,
      interactionMode: interaction.mode,
      interactionTheta: interaction.theta,
      interactionPhi: interaction.phi,
      interactionStrength: interaction.strength,
      interactionRadius: interaction.radius,
      pad0: 0,
      pad1: 0,
    };
    const buf = new Float32Array(48);
    const u32 = new Uint32Array(buf.buffer);
    UNIFORM_FIELDS.forEach((field, i) => {
      if (U32_FIELDS.has(field)) u32[i] = data[field] as number;
      else buf[i] = data[field] as number;
    });
    this.device.queue.writeBuffer(this.uniformBuffer, 0, buf);
  }

  step(frameDt: number, interaction: Interaction = NO_INTERACTION): void {
    const physicalDt = frameDt * this.params.timeScale;
    const subDt = physicalDt / this.maxSubSteps;
    for (let s = 0; s < this.maxSubSteps; s++) {
      this.dispatchSubstep(subDt, interaction);
      this.simTime += subDt;
    }
  }

  private dispatchSubstep(dt: number, interaction: Interaction): void {
    this.writeUniforms(dt, interaction);
    const encoder = this.device.createCommandEncoder();
    const wg = this.workgroups;

    // Pass 1: 平流 + 斜压注入 + 扩散（front -> back）
    {
      const pass = encoder.beginComputePass({ label: 'advect' });
      pass.setPipeline(this.advectPipeline);
      pass.setBindGroup(0, this.bindGroupFor(this.advectPipeline, this.front, this.back));
      pass.dispatchWorkgroups(wg.x, wg.y);
      pass.end();
    }
    this.swap();

    // Pass 2: Jacobi 迭代（每次迭代交换前后纹理）
    for (let it = 0; it < this.params.jacobiIterations; it++) {
      const pass = encoder.beginComputePass({ label: `jacobi-${it}` });
      pass.setPipeline(this.jacobiPipeline);
      pass.setBindGroup(0, this.bindGroupFor(this.jacobiPipeline, this.front, this.back));
      pass.dispatchWorkgroups(wg.x, wg.y);
      pass.end();
      this.swap();
    }

    // Pass 3: 膜厚更新
    {
      const pass = encoder.beginComputePass({ label: 'thickness' });
      pass.setPipeline(this.thicknessPipeline);
      pass.setBindGroup(0, this.bindGroupFor(this.thicknessPipeline, this.front, this.back));
      pass.dispatchWorkgroups(wg.x, wg.y);
      pass.end();
    }
    this.swap();

    this.device.queue.submit([encoder.finish()]);
  }

  private swap(): void {
    const tmp = this.front;
    this.front = this.back;
    this.back = tmp;
  }

  async readThickness(): Promise<Float32Array> {
    const buffer = this.device.createBuffer({
      size: this.nTheta * this.nPhi * 16,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = this.device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: this.front.h },
      { buffer, bytesPerRow: this.nPhi * 16, rowsPerImage: this.nTheta },
      { width: this.nPhi, height: this.nTheta },
    );
    this.device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const raw = new Float32Array(buffer.getMappedRange());
    const out = new Float32Array(this.nTheta * this.nPhi);
    for (let i = 0; i < out.length; i++) out[i] = raw[i * 4];
    buffer.unmap();
    buffer.destroy();
    return out;
  }

  async computeBlackFraction(): Promise<number> {
    const h = await this.readThickness();
    let black = 0;
    for (const v of h) if (v < this.recipe.hBlack) black++;
    this.blackFraction = black / h.length;
    return this.blackFraction;
  }

  destroy(): void {
    for (const t of [this.front, this.back]) {
      t.h.destroy(); t.gamma.destroy(); t.omega.destroy(); t.psi.destroy();
    }
    this.uniformBuffer.destroy();
  }
}
