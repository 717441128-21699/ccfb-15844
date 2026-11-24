import { defineConfig } from '@playwright/test';

// 展项 WebGPU 冒烟测试：使用带 WebGPU/ANGLE 标志的系统 Chrome
export default defineConfig({
  testDir: './test-e2e',
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  webServer: {
    command: 'npx vite --port 5174 --strictPort',
    url: 'http://localhost:5174',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
  use: {
    headless: true,
    channel: 'chrome',
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
      '--use-angle=swiftshader',
      '--enable-webgpu-developer-features',
      '--disable-gpu-sandbox',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--enable-logging=stderr',
    ],
    launchOptions: {
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    },
  },
});
