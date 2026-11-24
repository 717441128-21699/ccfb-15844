/** WebGPU 设备初始化与能力检测 */
export interface GpuContext {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
}

export async function initWebGPU(canvas: HTMLCanvasElement): Promise<GpuContext> {
  if (!('gpu' in navigator)) {
    throw new Error('当前浏览器不支持 WebGPU，请使用 Chrome/Edge 113+ 或开启实验标志。');
  }
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: 'high-performance',
  });
  if (!adapter) throw new Error('未找到可用的 GPU 适配器。');
  const device = await adapter.requestDevice();
  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('无法获取 WebGPU 画布上下文。');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format,
    alphaMode: 'opaque',
  });
  // 收集 WebGPU 校验错误，供自动化测试与现场诊断
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (ev) => {
    const msg = ev.error?.message ?? String(ev.error);
    errors.push(msg);
    console.error('[WebGPU uncapturederror]', msg);
  });
  (globalThis as Record<string, unknown>).__gpuErrors = errors;
  device.lost.then((info) => {
    console.error('WebGPU 设备丢失：', info.message);
  });
  return { device, context, format };
}

export function isWebGPUAvailable(): boolean {
  return 'gpu' in navigator;
}
