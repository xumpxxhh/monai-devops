import type { WorkflowDraft } from './workflows';
import { apiDelete, apiGet, apiPost } from './http';
import type {
  DevelopmentAttempt,
  DevelopmentObject,
  PaginatedResponse,
  RunRecord,
  SerializedWorkflowLifecycleEvent,
} from '../types';

export interface RunControlCommandResponse {
  commandId: string;
  status: 'pending' | 'applied' | 'rejected';
  error?: string;
}

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
  submit(
    workflow: WorkflowDraft,
    options?: { priority?: number; traceId?: string; initialState?: unknown },
  ) {
    return apiPost<{ runId: string; status: string }>('/runs', { workflow, ...options });
  },
  getEvents(runId: string) {
    return apiGet<{ runId: string; events: SerializedWorkflowLifecycleEvent[] }>(
      `/runs/${runId}/events`,
    );
  },
  getExecution(runId: string) {
    return apiGet<{ runId: string; attempts: DevelopmentAttempt[] }>(`/runs/${runId}/execution`);
  },
  signalWait(runId: string, attemptId: string, key: string, payload: unknown) {
    return apiPost<{ runId: string; attemptId: string; accepted: boolean }>(
      `/runs/${runId}/attempts/${attemptId}/signal`,
      { key, payload },
    );
  },
  getObject(runId: string, objectId: string) {
    return apiGet<DevelopmentObject>(`/runs/${runId}/objects/${objectId}`);
  },
  listChildren(runId: string) {
    return apiGet<{ runId: string; children: RunRecord[] }>(`/runs/${runId}/children`);
  },
  cancel(runId: string, options?: { mode?: 'best-effort' | 'hard' }) {
    return apiPost<{
      runId: string;
      status: string;
      cancelled?: 'best-effort' | 'hard';
      inFlightSteps?: string[];
      control: RunControlCommandResponse;
    }>(`/runs/${runId}/cancel`, options);
  },
  pause(runId: string, options?: { waitInFlight?: boolean; abortInFlight?: boolean }) {
    return apiPost<{
      runId: string;
      status: string;
      inFlightSteps?: string[];
      control: RunControlCommandResponse;
    }>(`/runs/${runId}/pause`, options);
  },
  resume(runId: string) {
    return apiPost<{ runId: string; status: string; control: RunControlCommandResponse }>(
      `/runs/${runId}/resume`,
    );
  },
  remove(runId: string) {
    return apiDelete<{ runId: string; deleted: boolean }>(`/runs/${runId}`);
  },
};
