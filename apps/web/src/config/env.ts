/// <reference types="vite/client" />

/** 前端路由 basename：去掉末尾 `/`，根路径为 `""` */
function toRouterBasename(basePath: string): string {
  if (!basePath || basePath === '/') return '';
  return basePath.replace(/\/$/, '');
}

const rawBasePath = import.meta.env.DEVOPS_BASE_PATH ?? '/';

/** 供 React Router 使用的路由基地址（非 API、非静态资源 base） */
export const routerBasename = toRouterBasename(rawBasePath);

/** 后端 API 基地址（含 GLOBAL_API_PREFIX） */
export const apiBaseUrl = import.meta.env.DEVOPS_API_BASE_URL ?? '';
