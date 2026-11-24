import { defineConfig } from 'vite';

// 科技馆大屏展项：4K 全屏，禁用外部 CDN，全部资源本地打包
export default defineConfig({
  base: './',
  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 1500,
  },
  server: {
    host: true,
    port: 5173,
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
