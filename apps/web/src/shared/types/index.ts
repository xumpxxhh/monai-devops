export type {
  WorkflowDefinition,
  WorkflowStep,
  StepCondition,
  WorkflowRunResult,
  ExecutionResult,
  StepKindDefinition,
  WorkflowEventParent,
  WorkflowIterationChildResultSummary,
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
  failureKind?: 'plugin' | 'resource' | 'internal' | 'config_resolution' | 'subworkflow_failed';
  skipReason?:
    | 'condition_not_met'
    | 'dependency_failed'
    | 'workflow_aborted'
    | 'user_cancelled'
    | 'pause_interrupted';
}

export interface WorkflowRunResultSerialized {
  success: boolean;
  status: 'success' | 'failed' | 'cancelled';
  workflowId: string;
  results: ExecutionResultSerialized[];
  state?: unknown;
}

export type SerializedWorkflowStep = {
  id: string;
  name: string;
  kind?: 'plugin' | 'set_state' | 'workflow';
  plugin?: string;
  config?: Record<string, unknown>;
  patch?: Record<string, unknown>;
  workflowRef?: { importId: string };
  dependsOn?: string[];
};

export type SerializedWorkflowLifecycleEvent = {
  type: string;
  workflowRunId?: string;
  meta?: { workflowId: string; traceId?: string };
  workflow?: unknown;
  step?: SerializedWorkflowStep;
  result?: unknown;
  resourceType?: string;
  priority?: number;
  log?: { level?: string; message: string; data?: unknown; stream?: 'stdout' | 'stderr' };
  parent?: import('@monai-devops/core-engine').WorkflowEventParent;
  iteration?: number;
  childResult?: import('@monai-devops/core-engine').WorkflowIterationChildResultSummary;
};

export type PluginDryRunSseMessage =
  | { type: 'log'; event: SerializedWorkflowLifecycleEvent }
  | { type: 'done'; result: ExecutionResultSerialized }
  | { type: 'error'; message: string };

export type WsOutboundMessage =
  | { type: 'event'; runId: string; event: SerializedWorkflowLifecycleEvent }
  | { type: 'done'; runId: string; result: WorkflowRunResultSerialized }
  | { type: 'error'; runId?: string; message: string };

export type WsInboundMessage =
  | { type: 'subscribe'; runId: string; fromEventIndex?: number }
  | { type: 'unsubscribe'; runId: string }
  | { type: 'run'; workflow: import('@monai-devops/core-engine').WorkflowDefinition };

export type RunStatus =
  | 'queued'
  | 'running'
  | 'pausing'
  | 'paused'
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
  workflowSnapshot: import('@monai-devops/core-engine').WorkflowDefinition;
  status: RunStatus;
  traceId?: string;
  counts: RunCounts;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: WorkflowRunResultSerialized;
  events: SerializedWorkflowLifecycleEvent[];
  cancelled?: 'best-effort' | 'hard';
  parentRunId?: string;
  source?: string;
  metadata?: {
    stepId?: string;
    iteration?: number;
    [key: string]: unknown;
  };
}

export type WorkflowImportMode = 'reference' | 'copy';

export interface WorkflowImportRecord {
  id: string;
  parentWorkflowId: string;
  childWorkflowId: string;
  stepId: string;
  mode: WorkflowImportMode;
  createdAt: string;
  childWorkflowName?: string;
  childWorkflowUpdatedAt?: string;
  /** 子工作流 definition.stateSchema（有则返回，供父侧配置 inputState） */
  childStateSchema?: Record<string, unknown>;
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
  hasConfigSchema?: boolean;
  hasResultSchema?: boolean;
}

export interface PluginConfigSchemaResponse {
  name: string;
  configJsonSchema: {
    type?: string;
    properties?: Record<
      string,
      {
        type?: string;
        enum?: Array<string | number | boolean>;
        default?: unknown;
        minLength?: number;
        description?: string;
        properties?: Record<string, unknown>;
        items?: unknown;
      }
    >;
    required?: string[];
    additionalProperties?: boolean;
  } | null;
}

export interface PluginResultSchemaResponse {
  name: string;
  resultJsonSchema: PluginConfigSchemaResponse['configJsonSchema'];
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
