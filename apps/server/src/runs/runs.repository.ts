import type { WorkflowDefinition } from '@monai-devops/core-engine';
import type {
  SerializedWorkflowLifecycleEvent,
  SerializedWorkflowRunResult,
} from '../common/serialization/serialize-workflow-event.js';

export type RunStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'pausing'
  | 'finished'
  | 'failed'
  | 'rejected'
  | 'cancelled';

export interface RunCounts {
  total: number;
  completed: number;
  failed: number;
  skipped: number;
}

export interface RunRecord {
  runId: string;
  workflowId: string;
  workflowSnapshot: WorkflowDefinition;
  status: RunStatus;
  traceId?: string;
  counts: RunCounts;
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  result?: SerializedWorkflowRunResult;
  events: SerializedWorkflowLifecycleEvent[];
  cancelled?: 'best-effort';
}

export interface RunListFilter {
  status?: RunStatus;
  workflowId?: string;
  search?: string;
  page: number;
  pageSize: number;
}

export interface RunRepository {
  save(record: RunRecord): Promise<void>;
  update(runId: string, patch: Partial<RunRecord>): Promise<RunRecord | undefined>;
  findById(runId: string): Promise<RunRecord | undefined>;
  list(filter: RunListFilter): Promise<{ items: RunRecord[]; total: number }>;
  appendEvent(runId: string, event: SerializedWorkflowLifecycleEvent): Promise<void>;
  delete(runId: string): Promise<boolean>;
  countActive(): Promise<number>;
  countByStatus(status: RunStatus): Promise<number>;
}

export const RUN_REPOSITORY = Symbol('RUN_REPOSITORY');
