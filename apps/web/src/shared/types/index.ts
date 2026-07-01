export type {
  WorkflowDefinition,
  WorkflowStep,
  StepCondition,
  WorkflowRunResult,
  ExecutionResult,
} from '@monai-devops/core-engine';

export interface SerializedError {
  name: string;
  message: string;
}

export interface ExecutionResultSerialized {
  stepId: string;
  status: 'completed' | 'skipped' | 'failed';
  success: boolean;
  result?: unknown;
  pluginResult?: {
    success: boolean;
    message?: string;
    data?: unknown;
    code?: string;
  };
  error?: SerializedError;
  failureKind?: 'plugin' | 'resource' | 'internal';
  skipReason?: 'condition_not_met' | 'dependency_failed' | 'workflow_aborted';
}

export interface WorkflowRunResultSerialized {
  success: boolean;
  workflowId: string;
  results: ExecutionResultSerialized[];
}

export type SerializedWorkflowLifecycleEvent = {
  type: string;
  meta?: { runId: string; workflowId: string; traceId?: string };
  workflow?: unknown;
  step?: { id: string; name: string; plugin: string };
  result?: unknown;
  resourceType?: string;
  priority?: number;
  log?: { level?: string; message: string; data?: unknown; stream?: 'stdout' | 'stderr' };
};

export type WsOutboundMessage =
  | { type: 'event'; event: SerializedWorkflowLifecycleEvent }
  | { type: 'done'; result: WorkflowRunResultSerialized }
  | { type: 'error'; message: string };

export type WsInboundMessage =
  | { type: 'subscribe'; runId: string }
  | { type: 'unsubscribe'; runId: string }
  | { type: 'run'; workflow: import('@monai-devops/core-engine').WorkflowDefinition };

export type RunStatus = 'queued' | 'running' | 'finished' | 'failed' | 'rejected' | 'cancelled';

export interface RunCounts {
  total: number;
  completed: number;
  failed: number;
  skipped: number;
}

export interface RunRecord {
  runId: string;
  workflowId: string;
  workflowSnapshot: import('@monai-devops/core-engine').WorkflowDefinition;
  status: RunStatus;
  traceId?: string;
  counts: RunCounts;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: WorkflowRunResultSerialized;
  events: SerializedWorkflowLifecycleEvent[];
  cancelled?: 'best-effort';
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface WorkflowRecord {
  id: string;
  definition: import('@monai-devops/core-engine').WorkflowDefinition;
  createdAt: string;
  updatedAt: string;
}

export interface PluginInfo {
  name: string;
  version: string;
  description?: string;
}

export interface ResourceSlot {
  id: string;
  type: string;
  name: string;
  status: string;
}

export interface QueueStatus {
  byType: Record<string, { queueLength: number; runningCount: number }>;
}

export interface StatsOverview {
  activeRuns: number;
  finishedRuns: number;
  failedRuns: number;
  successRate: number;
  pluginCount: number;
  queue: QueueStatus;
}

export interface ApiErrorBody {
  statusCode: number;
  message: string;
  error?: string;
  code?: string;
  details?: unknown;
}
