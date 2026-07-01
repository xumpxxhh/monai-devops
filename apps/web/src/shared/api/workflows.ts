import type { WorkflowDefinition } from '@monai-devops/core-engine';
import { apiDelete, apiGet, apiPost, apiPut } from './http';
import type { PaginatedResponse, WorkflowRecord } from '../types';

export const workflowsApi = {
  list(params?: { search?: string; page?: number; pageSize?: number }) {
    return apiGet<PaginatedResponse<WorkflowRecord>>('/workflows', params);
  },
  get(id: string) {
    return apiGet<WorkflowRecord>(`/workflows/${id}`);
  },
  create(definition: WorkflowDefinition) {
    return apiPost<WorkflowRecord>('/workflows', definition);
  },
  update(id: string, definition: WorkflowDefinition) {
    return apiPut<WorkflowRecord>(`/workflows/${id}`, definition);
  },
  remove(id: string) {
    return apiDelete<{ id: string; deleted: boolean }>(`/workflows/${id}`);
  },
  validate(definition: WorkflowDefinition) {
    return apiPost<{ valid: boolean }>('/workflows/validate', definition);
  },
  run(
    id: string,
    options?: {
      priority?: number;
      traceId?: string;
      failFast?: boolean;
      maxParallelSteps?: number;
    },
  ) {
    return apiPost<{ runId: string; status: string }>(`/workflows/${id}/run`, options ?? {});
  },
};
