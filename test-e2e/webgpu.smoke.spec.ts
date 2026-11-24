import { test, expect, type Page } from '@playwright/test';

const VITE_URL = 'http://localhost:5174';

async function collectGpuErrors(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const g = globalThis as unknown as { __gpuErrors?: string[] };
    return g.__gpuErrors ?? [];
  });
}

test.beforeAll(async () => {
  // Vite dev server 由 webServer 自动拉起
});

test('WebGPU 设备初始化且无校验错误', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`${VITE_URL}/#/show`);
  await page.waitForFunction('window.__appReady === true', { timeout: 20000 });
  await page.waitForFunction('window.__engine !== undefined', { timeout: 20000 });
  const hasGpu = await page.evaluate(() => 'gpu' in navigator);
  expect(hasGpu).toBe(true);
  // 等待若干帧让计算管线全部执行
  await page.waitForTimeout(2500);
  const gpuErrors = await collectGpuErrors(page);
  expect(gpuErrors, `WebGPU 校验错误：\n${gpuErrors.join('\n')}`).toEqual([]);
  expect(pageErrors, `页面异常：\n${pageErrors.join('\n')}`).toEqual([]);
});

test('吹满六个泡泡后仿真与渲染持续运行、无 WebGPU 错误', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const consoleMsgs: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleMsgs.push(m.text()); });
  await page.goto(`${VITE_URL}/#/show`);
  await page.waitForFunction('window.__engine !== undefined', { timeout: 20000 });
  const overlayHidden = await page.evaluate(() =>
    document.querySelector<HTMLElement>('#gpu-error')!.hidden);
  if (!overlayHidden) {
    throw new Error(`GPU 错误遮罩弹出：${await page.textContent('#gpu-error-msg')}`);
  }
  await page.click('#btn-blow6');
  const count = await page.evaluate(() => {
    const eng = (window as unknown as { __engine: { manager: { count: number } } }).__engine;
    return eng.manager.count;
  });
  expect(count).toBe(6);
  await page.waitForTimeout(3000);
  const gpuErrors = await collectGpuErrors(page);
  expect(gpuErrors, `WebGPU 校验错误：\n${gpuErrors.join('\n')}`).toEqual([]);
  // FPS 徽标出现且数值合理
  await page.waitForSelector('#fps-badge:not([hidden])', { timeout: 15000 });
  const fpsText = await page.textContent('#fps-badge');
  expect(fpsText).toContain('fps');
});

test('戳泡交互通过引擎 API 触发破裂', async ({ page }) => {
  await page.goto(`${VITE_URL}/#/show`);
  await page.waitForFunction('window.__engine !== undefined', { timeout: 20000 });
  await page.click('#btn-blow6');
  const before = await page.evaluate(() =>
    (window as unknown as { __engine: { manager: { count: number } } }).__engine.manager.count);
  expect(before).toBe(6);
  // 直接调用戳泡（命中第一个泡泡中心）
  await page.evaluate(() => {
    const eng = (window as unknown as {
      __engine: { manager: { bubbles: unknown[]; popAt: (p: number[]) => boolean } };
    }).__engine;
    // popAt 接受世界坐标，传入泡泡内部点即可命中
    const b = (eng.manager as unknown as { bubbles: { center: number[] }[] }).bubbles[0];
    eng.manager.popAt(b.center);
  });
  await page.waitForTimeout(800);
  const gpuErrors = await collectGpuErrors(page);
  expect(gpuErrors).toEqual([]);
  // 破裂动画推进后，活跃泡泡数应减少
  const active = await page.evaluate(() =>
    (window as unknown as { __engine: { manager: { activeCount: number } } }).__engine.manager.activeCount);
  expect(active).toBeLessThan(6);
});

test('膜厚剖面页可回读 GPU 纹理并绘制曲线', async ({ page }) => {
  await page.goto(`${VITE_URL}/#/profile`);
  await page.waitForFunction('window.__engine !== undefined', { timeout: 20000 });
  await page.waitForTimeout(2000);
  const readout = await page.textContent('#readout');
  expect(readout).toContain('顶部膜厚');
  expect(readout).toContain('黑膜面积占比');
  const gpuErrors = await collectGpuErrors(page);
  expect(gpuErrors).toEqual([]);
});

test('干涉原理页与参数页正常渲染', async ({ page }) => {
  await page.goto(`${VITE_URL}/#/optics`);
  await page.waitForSelector('#cv-newton');
  await page.waitForTimeout(500);
  await page.goto(`${VITE_URL}/#/params`);
  await page.waitForSelector('.recipe-card');
  const cards = await page.$$('.recipe-card');
  expect(cards.length).toBe(4);
});

test('参数页四张配方卡片渲染', async ({ page }) => {
  await page.goto(`${VITE_URL}/#/params`);
  await page.waitForSelector('.recipe-card');
  const cards = await page.$$('.recipe-card');
  expect(cards.length).toBe(4);
  const names = await page.$$eval('.recipe-card h4', (els) => els.map((e) => e.textContent));
  expect(names).toEqual(expect.arrayContaining(['基础餐洗配方', '甘油长寿配方', '糖浆大泡配方', '专业展项配方']));
});

test('在展示页切换配方重建 LUT 无 WebGPU 错误', async ({ page }) => {
  await page.goto(`${VITE_URL}/#/show`);
  await page.waitForFunction('window.__engine !== undefined', { timeout: 20000 });
  // 通过引擎 API 切换全部四种配方，触发 LUT 重建
  const ok = await page.evaluate(async () => {
    const eng = (window as unknown as {
      __engine: { setRecipe: (id: string) => void; recipe: { id: string } };
    }).__engine;
    for (const id of ['basic', 'glycerol', 'sugar', 'polymer']) {
      eng.setRecipe(id);
      if (eng.recipe.id !== id) return false;
    }
    // 等待 GPU 队列完成
    await eng.gpu.device.queue.onSubmittedWorkDone();
    return true;
  });
  expect(ok).toBe(true);
  await page.waitForTimeout(1000);
  const gpuErrors = await collectGpuErrors(page);
  expect(gpuErrors, `WebGPU 校验错误：\n${gpuErrors.join('\n')}`).toEqual([]);
});
