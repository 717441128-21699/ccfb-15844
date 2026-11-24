/**
 * WGSL 预处理：把 `#include "./xxx.wgsl"` 替换为对应文件内容。
 * Vite 以 ?raw 导入着色器源码，保证全部资源本地打包、离线可用。
 */
import commonWgsl from './shaders/common.wgsl?raw';

const INCLUDE_RE = /#include\s+"\.\/([\w.]+)"/g;

const SOURCES: Record<string, string> = {
  'common.wgsl': commonWgsl,
};

export function preprocessWgsl(src: string): string {
  return src.replace(INCLUDE_RE, (_match, name: string) => {
    const body = SOURCES[name];
    if (!body) throw new Error(`找不到 WGSL include: ${name}`);
    return body;
  });
}

export function createShaderModule(device: GPUDevice, code: string, label?: string): GPUShaderModule {
  return device.createShaderModule({ code: preprocessWgsl(code), label });
}
