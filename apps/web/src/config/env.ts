/// <reference types="vite/client" />

function toRouterBasename(basePath: string): string {
  if (!basePath || basePath === '/') return '';
  return basePath.replace(/\/$/, '');
}

const rawBasePath = import.meta.env.DEVOPS_BASE_PATH ?? '/';

export const routerBasename = toRouterBasename(rawBasePath);

export const apiBaseUrl = import.meta.env.DEVOPS_API_BASE_URL ?? '';

function buildWsUrl(pathSuffix: string): string {
  if (!apiBaseUrl) return '';
  try {
    const url = new URL(apiBaseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = `${url.pathname.replace(/\/$/, '')}${pathSuffix}`;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

/** 主运行 WebSocket 通道 */
export function getRunsWsUrl(): string {
  return buildWsUrl('/runs/ws');
}

/** 兼容旧 test-devops WebSocket */
export function getTestDevopsWsUrl(): string {
  return buildWsUrl('/test-devops/ws');
}
