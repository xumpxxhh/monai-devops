import type { WorkflowDefinition } from '@monai-devops/core-engine';
import type {
  SerializedWorkflowLifecycleEvent,
  SerializedWorkflowRunResult,
} from '../common/serialization/serialize-workflow-event.js';

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
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
  cancelled?: 'best-effort' | 'hard';
  createdBy?: bigint;
  source?: string;
  metadata?: Record<string, unknown>;
  parentRunId?: string;
}

export interface RunListFilter {
  status?: RunStatus;
  workflowId?: string;
  search?: string;
  /** 对应 runs.metadata jsonb；后续可扩展筛选维度 */
  metadata?: Record<string, unknown>;
  parentRunId?: string;
  page: number;
  pageSize: number;
}

export interface RunRepository {
  save(record: RunRecord, recoveryState?: unknown): Promise<void>;
  update(runId: string, patch: Partial<RunRecord>): Promise<RunRecord | undefined>;
  findById(runId: string): Promise<RunRecord | undefined>;
  list(filter: RunListFilter): Promise<{ items: RunRecord[]; total: number }>;
  listByParentRunId(parentRunId: string): Promise<RunRecord[]>;
  appendEvent(runId: string, event: SerializedWorkflowLifecycleEvent): Promise<number | undefined>;
  delete(runId: string): Promise<boolean>;
  countActive(): Promise<number>;
  countByStatus(status: RunStatus): Promise<number>;
  /** 私有恢复状态不进入 RunRecord 或公开 API。 */
  getRecoveryState(runId: string): Promise<{ present: boolean; value?: unknown }>;
  acquireRunLease(runId: string, ownerId: string, token: string, expiresAt: Date): Promise<boolean>;
  heartbeatRunLease(runId: string, token: string, expiresAt: Date): Promise<boolean>;
  releaseRunLease(runId: string, token: string): Promise<boolean>;
  /** 持有 Run lease 时将永久不可恢复的 Run 结算为可审计失败；重复调用不得追加终态事件。 */
  settleRecoveryBlocked(runId: string, token: string, reason: string): Promise<boolean>;
  listRecoverableRunIds(
    now: Date,
    unleasedBefore: Date,
    limit: number,
    excludeRunIds?: string[],
  ): Promise<string[]>;
}

export const RUN_REPOSITORY = Symbol('RUN_REPOSITORY');
