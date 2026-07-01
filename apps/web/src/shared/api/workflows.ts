import type { WorkflowStep } from '@monai-devops/core-engine';
import { apiDelete, apiGet, apiPost, apiPut } from './http';
import type { PaginatedResponse, WorkflowRecord } from '../types';

export type WorkflowDraftStep = Omit<WorkflowStep, 'id'> & {
  id?: string;
  clientRef?: string;
};

export type WorkflowDraft = {
  id?: string;
  name: string;
  steps: WorkflowDraftStep[];
};

export const workflowsApi = {
  list(params?: { search?: string; page?: number; pageSize?: number }) {
    return apiGet<PaginatedResponse<WorkflowRecord>>('/workflows', params);
  },
  get(id: string) {
    return apiGet<WorkflowRecord>(`/workflows/${id}`);
  },
  create(draft: WorkflowDraft) {
    return apiPost<WorkflowRecord>('/workflows', draft);
  },
  update(id: string, draft: WorkflowDraft) {
    return apiPut<WorkflowRecord>(`/workflows/${id}`, draft);
  },
  remove(id: string) {
    return apiDelete<{ id: string; deleted: boolean }>(`/workflows/${id}`);
  },
  validate(draft: WorkflowDraft) {
    return apiPost<{ valid: boolean }>('/workflows/validate', draft);
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
