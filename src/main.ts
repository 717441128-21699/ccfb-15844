/** 应用入口：hash 路由 + 四个页面挂载 */
import { mountShowPage } from './ui/pages/showPage';
import { mountProfilePage } from './ui/pages/profilePage';
import { mountOpticsPage } from './ui/pages/opticsPage';
import { mountParamsPage } from './ui/pages/paramsPage';

const app = document.querySelector<HTMLDivElement>('#app')!;
const fpsBadge = document.querySelector<HTMLDivElement>('#fps-badge')!;
const gpuError = document.querySelector<HTMLDivElement>('#gpu-error')!;
const gpuErrorMsg = document.querySelector<HTMLParagraphElement>('#gpu-error-msg')!;

export function showGpuError(msg: string): void {
  gpuErrorMsg.textContent = msg;
  gpuError.hidden = false;
}

type Route = 'show' | 'profile' | 'optics' | 'params';
const ROUTES: Route[] = ['show', 'profile', 'optics', 'params'];

function currentRoute(): Route {
  const hash = location.hash.replace(/^#\//, '') as Route;
  return ROUTES.includes(hash) ? hash : 'show';
}

async function render() {
  const route = currentRoute();
  document.querySelectorAll<HTMLAnchorElement>('.nav-links a').forEach((a) => {
    a.classList.toggle('active', a.dataset.route === route);
  });
  app.innerHTML = '';
  fpsBadge.hidden = route !== 'show' && route !== 'profile';
  try {
    switch (route) {
      case 'show': await mountShowPage(app); break;
      case 'profile': await mountProfilePage(app); break;
      case 'optics': mountOpticsPage(app); break;
      case 'params': mountParamsPage(app); break;
    }
  } catch (err) {
    showGpuError(err instanceof Error ? err.message : String(err));
  }
}

window.addEventListener('hashchange', render);
if (!location.hash) location.hash = '#/show';
render();

// 自动化测试钩子
(window as unknown as Record<string, unknown>).__appReady = true;
