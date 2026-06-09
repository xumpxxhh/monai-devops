/**
 * 编排层错误与步骤状态类型
 * @module errors
 */

export const StepStatuses = {
  COMPLETED: 'completed',
  SKIPPED: 'skipped',
  FAILED: 'failed',
} as const;

export type StepStatus = (typeof StepStatuses)[keyof typeof StepStatuses];

export const StepFailureKinds = {
  PLUGIN: 'plugin',
  RESOURCE: 'resource',
  INTERNAL: 'internal',
} as const;

export type StepFailureKind = (typeof StepFailureKinds)[keyof typeof StepFailureKinds];

export const SkipReasons = {
  CONDITION_NOT_MET: 'condition_not_met',
  DEPENDENCY_FAILED: 'dependency_failed',
  WORKFLOW_ABORTED: 'workflow_aborted',
} as const;

export type SkipReason = (typeof SkipReasons)[keyof typeof SkipReasons];

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
