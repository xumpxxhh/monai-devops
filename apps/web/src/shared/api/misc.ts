import { apiGet, apiPost } from './http';
import type {
  ExecutionResultSerialized,
  PluginInfo,
  QueueStatus,
  ResourceSlot,
  StatsOverview,
} from '../types';

export const pluginsApi = {
  list() {
    return apiGet<PluginInfo[]>('/plugins');
  },
  get(name: string) {
    return apiGet<PluginInfo>(`/plugins/${name}`);
  },
  dryRun(name: string, config: Record<string, unknown>) {
    return apiPost<ExecutionResultSerialized>(`/plugins/${name}/dry-run`, { config });
  },
};

export const resourcesApi = {
  list() {
    return apiGet<ResourceSlot[]>('/resources');
  },
  queue() {
    return apiGet<QueueStatus>('/resources/queue');
  },
};

export const statsApi = {
  overview() {
    return apiGet<StatsOverview>('/stats/overview');
  },
};

export const healthApi = {
  check() {
    return apiGet<{ status: string; engineReady: boolean }>('/healthz');
  },
};
