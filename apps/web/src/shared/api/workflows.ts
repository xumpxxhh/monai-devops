import type { WorkflowStep } from '@monai-devops/core-engine';
import { apiDelete, apiGet, apiPost, apiPut } from './http';
import type {
  PaginatedResponse,
  StepKindDefinition,
  WorkflowImportMode,
  WorkflowImportRecord,
  WorkflowRecord,
} from '../types';

/** Omit 对联合不分配；需先展开各成员再去掉 id，否则会丢掉 plugin/patch/workflowRef 等判别字段 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type WorkflowDraftStep = DistributiveOmit<WorkflowStep, 'id'> & {
  id?: string;
  clientRef?: string;
};

export type WorkflowDraft = {
  id?: string;
  name: string;
  stateSchema?: Record<string, unknown>;
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
      initialState?: unknown;
    },
  ) {
    return apiPost<{ runId: string; status: string }>(`/workflows/${id}/run`, options ?? {});
  },
  listImports(id: string) {
    return apiGet<WorkflowImportRecord[]>(`/workflows/${id}/imports`);
  },
  createImport(
    id: string,
    body: { childWorkflowId: string; mode: WorkflowImportMode; stepId?: string },
  ) {
    return apiPost<WorkflowImportRecord>(`/workflows/${id}/imports`, body);
  },
};

export const stepKindsApi = {
  list() {
    return apiGet<StepKindDefinition[]>('/step-kinds');
  },
};
