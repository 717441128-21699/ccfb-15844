/**
 * 干涉 LUT 的 GPU 构建与缓存。
 * LUT 尺寸 hBins × angleBins，每个纹素存线性 sRGB（rgba16float，可过滤采样），
 * 由 lutBuild.wgsl 在计算管线中按全光谱积分生成，与 CPU buildInterferenceLUT 等价。
 */
import type { SoapRecipe } from '../physics/formulas';
import lutBuildWgsl from './shaders/lutBuild.wgsl?raw';
import { createShaderModule } from './shaderLoader';

export interface LUTSpec {
  hMax: number;
  angleMax: number;
  hBins: number;
  angleBins: number;
}

export const DEFAULT_LUT_SPEC: LUTSpec = {
  hMax: 2.5e-6,
  angleMax: (75 * Math.PI) / 180,
  hBins: 256,
  angleBins: 64,
};

export class InterferenceLUT {
  readonly texture: GPUTexture;
  readonly spec: LUTSpec;
  private device: GPUDevice;
  private pipeline: GPUComputePipeline;

  constructor(device: GPUDevice, recipe: SoapRecipe, spec: LUTSpec = DEFAULT_LUT_SPEC) {
    this.device = device;
    this.spec = spec;
    this.texture = device.createTexture({
      size: { width: spec.hBins, height: spec.angleBins },
      // rgba16float 既可作为 storage 写入，又支持线性过滤采样（rgba32float 不可过滤）
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      label: 'interference-lut',
    });
    this.pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: createShaderModule(device, lutBuildWgsl, 'lut-build'), entryPoint: 'main' },
    });
    this.rebuild(recipe);
  }

  rebuild(recipe: SoapRecipe): void {
    const { device } = this;
    const uniformBuffer = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const data = new Float32Array(8);
    data[0] = this.spec.hMax;
    data[1] = this.spec.angleMax;
    new Uint32Array(data.buffer)[2] = this.spec.hBins;
    new Uint32Array(data.buffer)[3] = this.spec.angleBins;
    data[4] = recipe.cauchyA;
    data[5] = recipe.cauchyB;
    device.queue.writeBuffer(uniformBuffer, 0, data);

    const bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: this.texture.createView() },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass({ label: 'lut-build' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(this.spec.hBins / 8), Math.ceil(this.spec.angleBins / 8));
    pass.end();
    device.queue.submit([encoder.finish()]);
    uniformBuffer.destroy();
  }

  destroy(): void {
    this.texture.destroy();
  }
}
