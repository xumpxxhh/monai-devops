import type { WorkflowDefinition } from '@monai-devops/core-engine';
import { apiDelete, apiGet, apiPost } from './http';
import type { PaginatedResponse, RunRecord, SerializedWorkflowLifecycleEvent } from '../types';

export const runsApi = {
  list(params?: {
    status?: string;
    workflowId?: string;
    search?: string;
    page?: number;
    pageSize?: number;
  }) {
    return apiGet<PaginatedResponse<RunRecord>>('/runs', params);
  },
  get(runId: string) {
    return apiGet<RunRecord>(`/runs/${runId}`);
  },
  submit(workflow: WorkflowDefinition, options?: { priority?: number; traceId?: string }) {
    return apiPost<{ runId: string; status: string }>('/runs', { workflow, ...options });
  },
  getEvents(runId: string) {
    return apiGet<{ runId: string; events: SerializedWorkflowLifecycleEvent[] }>(
      `/runs/${runId}/events`,
    );
  },
  cancel(runId: string) {
    return apiPost<{ runId: string; status: string; cancelled?: string }>(`/runs/${runId}/cancel`);
  },
  remove(runId: string) {
    return apiDelete<{ runId: string; deleted: boolean }>(`/runs/${runId}`);
  },
};
