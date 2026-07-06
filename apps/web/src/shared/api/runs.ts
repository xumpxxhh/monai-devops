import type { WorkflowDraft } from './workflows';
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
  submit(workflow: WorkflowDraft, options?: { priority?: number; traceId?: string }) {
    return apiPost<{ runId: string; status: string }>('/runs', { workflow, ...options });
  },
  getEvents(runId: string) {
    return apiGet<{ runId: string; events: SerializedWorkflowLifecycleEvent[] }>(
      `/runs/${runId}/events`,
    );
  },
  cancel(runId: string, options?: { mode?: 'best-effort' | 'hard' }) {
    return apiPost<{
      runId: string;
      status: string;
      cancelled?: 'best-effort' | 'hard';
      inFlightSteps?: string[];
    }>(`/runs/${runId}/cancel`, options);
  },
  pause(runId: string, options?: { waitInFlight?: boolean; abortInFlight?: boolean }) {
    return apiPost<{ runId: string; status: string; inFlightSteps?: string[] }>(
      `/runs/${runId}/pause`,
      options,
    );
  },
  resume(runId: string) {
    return apiPost<{ runId: string; status: string }>(`/runs/${runId}/resume`);
  },
  remove(runId: string) {
    return apiDelete<{ runId: string; deleted: boolean }>(`/runs/${runId}`);
  },
};
