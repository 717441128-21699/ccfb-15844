// 下载 MediaPipe HandLandmarker 模型到 public/mediapipe（展项离线运行所需）。
// 模型来自 Google 官方存储，国内网络不通时可手动放置同名文件。
import { createWriteStream, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dstDir = resolve(root, 'public/mediapipe');
const dst = resolve(dstDir, 'hand_landmarker.task');
const URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

if (existsSync(dst)) {
  console.log('hand_landmarker.task 已存在，跳过下载');
} else {
  await mkdir(dstDir, { recursive: true });
  console.log('下载 HandLandmarker 模型...');
  const res = await fetch(URL);
  if (!res.ok || !res.body) {
    console.error(`下载失败 HTTP ${res.status}，请手动下载：\n${URL}\n放到 ${dst}`);
    process.exit(1);
  }
  const stream = createWriteStream(dst);
  for await (const chunk of res.body) stream.write(chunk);
  stream.end();
  await new Promise((r) => stream.on('finish', r));
  console.log('已保存到', dst);
}
