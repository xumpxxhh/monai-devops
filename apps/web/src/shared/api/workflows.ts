import type { WorkflowDefinition } from '@monai-devops/core-engine';
import { apiDelete, apiGet, apiPost, apiPut } from './http';
import type { PaginatedResponse } from '../types';

export const workflowsApi = {
  list(params?: { search?: string; page?: number; pageSize?: number }) {
    return apiGet<PaginatedResponse<WorkflowDefinition>>('/workflows', params);
  },
  get(id: string) {
    return apiGet<WorkflowDefinition>(`/workflows/${id}`);
  },
  create(definition: WorkflowDefinition) {
    return apiPost<WorkflowDefinition>('/workflows', definition);
  },
  update(id: string, definition: WorkflowDefinition) {
    return apiPut<WorkflowDefinition>(`/workflows/${id}`, definition);
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
