// 将 MediaPipe tasks-vision 的 WASM 运行时复制到 public，保证展项完全离线可用
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const dst = resolve(root, 'public/mediapipe');

if (!existsSync(src)) {
  console.error('未找到 @mediapipe/tasks-vision wasm 目录，请先 npm install');
  process.exit(1);
}
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });
console.log('MediaPipe WASM 已复制到 public/mediapipe');
