import { apiGet, apiPostSse } from './http';
import type {
  ExecutionResultSerialized,
  PluginConfigSchemaResponse,
  PluginDryRunSseMessage,
  PluginInfo,
  QueueStatus,
  ResourceSlot,
  SerializedWorkflowLifecycleEvent,
  StatsOverview,
} from '../types';

export interface DryRunOptions {
  onLog?: (event: SerializedWorkflowLifecycleEvent) => void;
}

export const pluginsApi = {
  list() {
    return apiGet<PluginInfo[]>('/plugins');
  },
  get(name: string) {
    return apiGet<PluginInfo>(`/plugins/${name}`);
  },
  getConfigSchema(name: string) {
    return apiGet<PluginConfigSchemaResponse>(`/plugins/${name}/config-schema`);
  },
  dryRun(name: string, config: Record<string, unknown>, options: DryRunOptions = {}) {
    return new Promise<ExecutionResultSerialized>((resolve, reject) => {
      let settled = false;

      void apiPostSse<PluginDryRunSseMessage>(`/plugins/${name}/dry-run`, { config }, (message) => {
        if (message.type === 'log') {
          options.onLog?.(message.event);
          return;
        }

        if (message.type === 'done') {
          settled = true;
          resolve(message.result);
          return;
        }

        if (message.type === 'error') {
          settled = true;
          reject(new Error(message.message));
        }
      }).catch((error: unknown) => {
        if (!settled) {
          reject(error instanceof Error ? error : new Error('试运行失败'));
        }
      });
    });
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
