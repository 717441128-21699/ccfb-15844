/**
 * 泡泡渲染器：全屏三角形 + 片元级光线-球面求交。
 * 最多 6 个泡泡实例；膜厚纹理复制进 2d-array（rgba32float，手动双线性），
 * 干涉 LUT 为可过滤的 rgba16float。
 */
import bubbleWgsl from './shaders/bubble.wgsl?raw';
import { createShaderModule } from './shaderLoader';
import type { InterferenceLUT } from './InterferenceLUT';
import type { FilmSimulatorGpu } from './FilmSimulatorGpu';

export interface BubbleView {
  center: [number, number, number];
  radius: number;
  popProgress: number;
  wobble: number;
  sim: FilmSimulatorGpu;
}

const MAX_BUBBLES = 6;
// BubbleInstance: 2 × vec4 = 32 字节
const INSTANCE_STRIDE = 32;

export class BubbleRenderer {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline;
  private cameraBuffer: GPUBuffer;
  private instanceBuffer: GPUBuffer;
  private lut: InterferenceLUT;
  private context: GPUCanvasContext;
  private sampler: GPUSampler;
  // 持久化膜厚数组纹理（避免每帧新建/销毁导致的 GPU 内存抖动）
  private arrayTexture: GPUTexture | null = null;
  private arrayLayerCount = 0;
  private arrayW = 0;
  private arrayH = 0;

  constructor(
    device: GPUDevice,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
    lut: InterferenceLUT,
  ) {
    this.device = device;
    this.context = context;
    this.lut = lut;

    this.cameraBuffer = device.createBuffer({
      size: 128,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.instanceBuffer = device.createBuffer({
      size: MAX_BUBBLES * INSTANCE_STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    // 仅 LUT 需要过滤采样（rgba16float 可过滤）
    this.sampler = device.createSampler({
      magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
    });

    const bindLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        // rgba32float 膜厚数组：不可过滤，仅 textureLoad
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' },
        },
        // rgba16float LUT：可过滤
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bindLayout] }),
      vertex: {
        module: createShaderModule(device, bubbleWgsl, 'bubble'),
        entryPoint: 'vs',
      },
      fragment: {
        module: createShaderModule(device, bubbleWgsl, 'bubble'),
        entryPoint: 'fs',
        targets: [{
          format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });
  }

  render(
    bubbles: BubbleView[],
    invViewProj: Float32Array,
    cameraPos: [number, number, number],
    clearColor: GPUColor = { r: 0.03, g: 0.04, b: 0.07, a: 1 },
  ): void {
    const count = Math.min(bubbles.length, MAX_BUBBLES);
    if (count === 0) {
      this.clearOnly(clearColor);
      return;
    }
    const instData = new Float32Array(MAX_BUBBLES * 8);
    for (let i = 0; i < count; i++) {
      const b = bubbles[i];
      instData[i * 8 + 0] = b.center[0];
      instData[i * 8 + 1] = b.center[1];
      instData[i * 8 + 2] = b.center[2];
      instData[i * 8 + 3] = b.radius;
      instData[i * 8 + 4] = i;
      instData[i * 8 + 5] = b.popProgress;
      instData[i * 8 + 6] = b.wobble;
    }
    this.device.queue.writeBuffer(this.instanceBuffer, 0, instData);

    const cam = new Float32Array(32);
    cam.set(invViewProj, 0);
    cam[16] = cameraPos[0];
    cam[17] = cameraPos[1];
    cam[18] = cameraPos[2];
    cam[19] = this.lut.spec.hMax;
    cam[20] = this.lut.spec.angleMax;
    new Uint32Array(cam.buffer)[21] = count;
    this.device.queue.writeBuffer(this.cameraBuffer, 0, cam);

    const nPhi = bubbles[0].sim.nPhi;
    const nTheta = bubbles[0].sim.nTheta;
    // 复用或按当前泡数重建持久化数组纹理（最多 6 层，直接按 6 层分配避免重建）
    if (
      !this.arrayTexture ||
      this.arrayW !== nPhi ||
      this.arrayH !== nTheta
    ) {
      this.arrayTexture?.destroy();
      this.arrayTexture = this.device.createTexture({
        size: { width: nPhi, height: nTheta, depthOrArrayLayers: MAX_BUBBLES },
        format: 'rgba32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.arrayW = nPhi;
      this.arrayH = nTheta;
      this.arrayLayerCount = MAX_BUBBLES;
    }
    const encoder = this.device.createCommandEncoder();
    for (let i = 0; i < count; i++) {
      encoder.copyTextureToTexture(
        { texture: bubbles[i].sim.currentHTexture },
        { texture: this.arrayTexture, mipLevel: 0, origin: { x: 0, y: 0, z: i } },
        { width: nPhi, height: nTheta },
      );
    }

    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: { buffer: this.instanceBuffer } },
        {
          binding: 2,
          resource: this.arrayTexture.createView({ dimension: '2d-array', arrayLayerCount: this.arrayLayerCount }),
        },
        { binding: 3, resource: this.lut.texture.createView() },
        { binding: 4, resource: this.sampler },
      ],
    });

    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: clearColor,
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    this.arrayTexture?.destroy();
    this.cameraBuffer.destroy();
    this.instanceBuffer.destroy();
  }

  private clearOnly(clearColor: GPUColor): void {
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: clearColor,
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }
}
