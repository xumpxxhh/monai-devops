/**
 * 执行器类型定义
 * @module executor/types
 */

import type { PluginConfig, PluginContext, PluginResult, ZodType } from '@monai-devops/plugin-sdk';
import type { SkipReason, StepFailureKind, StepStatus } from '../errors.js';
import type { WorkflowObserver, WorkflowRunMeta } from '../observer/index.js';

/**
 * 工作流定义
 */
export interface WorkflowDefinition {
  id: string;
  name: string;
  steps: WorkflowStep[];
}

/**
 * 结构化步骤条件
 */
export interface StepCondition {
  when: string;
  equals?: unknown;
  exists?: boolean;
}

/**
 * 工作流步骤
 */
export interface WorkflowStep {
  id: string;
  name: string;
  plugin: string;
  config: PluginConfig;
  condition?: StepCondition;
  dependsOn?: string[];
  /** 资源调度优先级，数值越小越优先；默认继承 run 级 priority */
  priority?: number;
}

/**
 * 执行上下文
 */
export interface ExecutionContext extends PluginContext {
  workflowId: string;
  stepId: string;
  previousResults?: Record<string, unknown>;
  /** 仅 COMPLETED 且 pluginResult.success 的 data（供 config $ref 解析） */
  previousResultsData?: Record<string, unknown>;
  artifacts?: Record<string, unknown>;
  /** run 级默认调度优先级，步骤 priority 可覆盖 */
  priority?: number;
}

/**
 * 执行结果
 */
export interface ExecutionResult {
  stepId: string;
  status: StepStatus;
  success: boolean;
  result?: unknown;
  pluginResult?: PluginResult;
  error?: Error;
  failureKind?: StepFailureKind;
  skipReason?: SkipReason;
}

export type WorkflowRunStatus = 'success' | 'failed' | 'cancelled';

export type RunControlStatus =
  | 'running'
  | 'pausing'
  | 'paused'
  | 'cancelling'
  | 'cancelled'
  | 'finished'
  | 'failed'
  | 'unknown';

export type AbortSchedulingReason = 'none' | 'fail_fast' | 'user_cancel' | 'destroy';

export type RunControlMode = 'best-effort' | 'hard';

export interface CancelRunOptions {
  mode?: RunControlMode;
}

export interface PauseRunOptions {
  waitInFlight?: boolean;
  abortInFlight?: boolean;
}

export interface RunControlResult {
  workflowRunId: string;
  action: 'cancel' | 'pause' | 'resume';
  previousStatus: RunControlStatus;
  currentStatus: RunControlStatus;
  mode?: RunControlMode;
  inFlightSteps?: string[];
}

export interface RunStatusSnapshot {
  workflowRunId: string;
  status: RunControlStatus;
  inFlightSteps: string[];
  progress?: { completed: number; total: number };
}

/**
 * 工作流运行结果
 */
export interface WorkflowRunResult {
  success: boolean;
  status: WorkflowRunStatus;
  workflowId: string;
  results: ExecutionResult[];
}

/**
 * onStepComplete 可选控制项（引擎用于推迟资源释放等）
 */
export interface StepCompleteOptions {
  /** 推迟资源释放，直至该 Promise settle（用于 in-flight abort 超时后插件仍在运行） */
  deferReleaseUntil?: Promise<unknown>;
}

/**
 * 插件执行器类型
 */
export type PluginExecutor = (
  pluginName: string,
  config: PluginConfig,
  context: PluginContext,
) => Promise<PluginResult>;

/**
 * 执行器选项
 */
export interface ExecutorOptions {
  pluginExecutor?: PluginExecutor;
  maxParallelSteps?: number;
  failFast?: boolean;
  /** hard cancel 时 in-flight 步骤超时（ms），默认 30000 */
  inFlightTimeoutMs?: number;
  /** 生命周期观察者，供调用层接收执行期事件 */
  observer?: WorkflowObserver;
  /** 引擎内部/高级定制：步骤开始钩子（在 step:start 之前 await，可用于资源挂起） */
  onStepStart?: (
    step: WorkflowStep,
    context: ExecutionContext,
    meta?: WorkflowRunMeta,
  ) => void | Promise<void>;
  /** 引擎内部/高级定制：步骤完成钩子（含失败与跳过） */
  onStepComplete?: (
    step: WorkflowStep,
    result: ExecutionResult,
    context: ExecutionContext,
    options?: StepCompleteOptions,
  ) => void;
  /** 引擎内部/高级定制：步骤错误钩子（失败时在 onStepComplete 之前调用） */
  onStepError?: (step: WorkflowStep, error: Error, context: ExecutionContext) => void;
  /** failFast 中止时取消同 workflowRunId 下排队中的资源等待 */
  onWorkflowAbort?: (workflowRunId: string) => void;
  /** 查询插件 resultSchema；用于启动前校验 ContextRef 来源是否允许被引用 */
  resolvePluginResultSchema?: (pluginName: string) => ZodType | undefined;
}
