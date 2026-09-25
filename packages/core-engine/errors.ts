/**
 * 编排层错误与步骤状态类型
 * @module errors
 */

export const StepStatuses = {
  COMPLETED: 'completed',
  SKIPPED: 'skipped',
  FAILED: 'failed',
  WAITING: 'waiting',
} as const;

/** checkpoint 已持久化，当前执行栈必须退出；不是步骤失败或工作流终态。 */
export class WorkflowSuspendedError extends Error {
  constructor(readonly stepId: string) {
    super(`Workflow suspended at step ${stepId}`);
    this.name = 'WorkflowSuspendedError';
  }
}

export type StepStatus = (typeof StepStatuses)[keyof typeof StepStatuses];

export const StepFailureKinds = {
  PLUGIN: 'plugin',
  RESOURCE: 'resource',
  INTERNAL: 'internal',
  CONFIG_RESOLUTION: 'config_resolution',
  /** 子工作流执行失败（workflow 步骤） */
  SUBWORKFLOW_FAILED: 'subworkflow_failed',
} as const;

export type StepFailureKind = (typeof StepFailureKinds)[keyof typeof StepFailureKinds];

export const SkipReasons = {
  CONDITION_NOT_MET: 'condition_not_met',
  DEPENDENCY_FAILED: 'dependency_failed',
  WORKFLOW_ABORTED: 'workflow_aborted',
  USER_CANCELLED: 'user_cancelled',
  PAUSE_INTERRUPTED: 'pause_interrupted',
} as const;

export type SkipReason = (typeof SkipReasons)[keyof typeof SkipReasons];

export const ExecutionReasonCategories = {
  BUSINESS: 'business',
  INFRASTRUCTURE: 'infrastructure',
  CONFIGURATION: 'configuration',
  INTERNAL: 'internal',
  DEPENDENCY: 'dependency',
  CONDITION: 'condition',
  POLICY: 'policy',
  CANCELLED: 'cancelled',
  INTERRUPTED: 'interrupted',
} as const;

export type ExecutionReasonCategory =
  (typeof ExecutionReasonCategories)[keyof typeof ExecutionReasonCategories];

/** 跨 core/server/event 使用的稳定原因结构；旧 failureKind/skipReason 继续保留。 */
export interface ExecutionReason {
  code: string;
  category: ExecutionReasonCategory;
  retryable: boolean;
  message?: string;
}

export type RunTerminalReasonCode =
  | 'step_failed'
  | 'user_cancelled'
  | 'engine_destroyed'
  | 'recovery_blocked';

/**
 * 工作流校验错误（启动前 DAG 校验失败时抛出）
 */
export class WorkflowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowValidationError';
  }
}

/**
 * 工作流执行实例 ID 校验错误（启动前 workflowRunId 非法时抛出）
 */
export class WorkflowRunIdValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowRunIdValidationError';
  }
}

/**
 * 步骤基础设施失败（资源分配等），由 executor 捕获并转为 ExecutionResult
 */
export class StepExecutionError extends Error {
  constructor(
    message: string,
    readonly kind: StepFailureKind,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'StepExecutionError';
  }
}

/**
 * 资源等待队列取消（failFast 等场景），由 executor 转为 SKIPPED / WORKFLOW_ABORTED
 */
export class ResourceQueueCancelledError extends Error {
  constructor(message = '资源等待已取消') {
    super(message);
    this.name = 'ResourceQueueCancelledError';
  }
}

/**
 * 同一 workflowRunId 已有活跃 Run 时抛出
 */
export class RunAlreadyActiveError extends Error {
  constructor(workflowRunId: string) {
    super(`workflowRunId 已有活跃 Run: ${workflowRunId}`);
    this.name = 'RunAlreadyActiveError';
  }
}

/**
 * 资源池注册失败（引擎配置/注册边界，池已满时由 engine 抛出）
 */
export class ResourceRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceRegistrationError';
  }
}
