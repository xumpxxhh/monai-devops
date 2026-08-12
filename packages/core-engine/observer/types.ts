/**
 * 工作流生命周期可观测性类型
 * @module observer/types
 */

import type {
  ExecutionContext,
  ExecutionResult,
  RunControlMode,
  WorkflowDefinition,
  WorkflowRunResult,
  WorkflowRunStatus,
  WorkflowStep,
} from '../executor/types.js';
import type { PluginLogEntry } from '@monai-devops/plugin-sdk';
import { WorkflowEventTypes } from './event-types.js';

/**
 * 单次工作流运行的元数据（不含实例 ID，实例 ID 见事件顶层 workflowRunId）
 */
export interface WorkflowRunMeta {
  workflowId: string;
  traceId?: string;
  /** 调用方 runWorkflow 传入的其余 ExecutionContext 字段 */
  context?: Partial<ExecutionContext>;
}

/**
 * 嵌入执行时挂靠到父 run 的维度（加法式可选字段）
 */
export interface WorkflowEventParent {
  /** 父 run 的 workflowRunId */
  runId: string;
  /** 父工作流中发起引用的步骤 id */
  stepId: string;
  /** 第几轮（从 0 开始） */
  iteration: number;
}

/**
 * 迭代结束事件携带的子 run 结果摘要（避免把完整 results/Error 塞进事件）
 */
export interface WorkflowIterationChildResultSummary {
  childRunId: string;
  success: boolean;
  status: WorkflowRunStatus;
  state?: unknown;
}

type WithOptionalParent<T> = T & { parent?: WorkflowEventParent };

/**
 * 工作流生命周期事件（discriminated union）
 */
export type WorkflowLifecycleEvent =
  | WithOptionalParent<{
      type: typeof WorkflowEventTypes.WORKFLOW_START;
      workflowRunId: string;
      meta: WorkflowRunMeta;
      workflow: WorkflowDefinition;
    }>
  | WithOptionalParent<{
      type: typeof WorkflowEventTypes.WORKFLOW_FINISHED;
      workflowRunId: string;
      meta: WorkflowRunMeta;
      result: WorkflowRunResult;
    }>
  | WithOptionalParent<{
      type: typeof WorkflowEventTypes.WORKFLOW_CANCELLED;
      workflowRunId: string;
      meta: WorkflowRunMeta;
      inFlightSteps: string[];
      mode: RunControlMode;
    }>
  | WithOptionalParent<{
      type: typeof WorkflowEventTypes.WORKFLOW_PAUSED;
      workflowRunId: string;
      meta: WorkflowRunMeta;
      inFlightSteps: string[];
    }>
  | WithOptionalParent<{
      type: typeof WorkflowEventTypes.WORKFLOW_RESUMED;
      workflowRunId: string;
      meta: WorkflowRunMeta;
    }>
  | WithOptionalParent<{
      type: typeof WorkflowEventTypes.WORKFLOW_ITERATION_START;
      /** 父 run id（迭代边界事件发生在父 observer 视角） */
      workflowRunId: string;
      meta: WorkflowRunMeta;
      step: WorkflowStep;
      iteration: number;
    }>
  | WithOptionalParent<{
      type: typeof WorkflowEventTypes.WORKFLOW_ITERATION_FINISHED;
      workflowRunId: string;
      meta: WorkflowRunMeta;
      step: WorkflowStep;
      iteration: number;
      childResult: WorkflowIterationChildResultSummary;
    }>
  | WithOptionalParent<{
      type: typeof WorkflowEventTypes.STEP_QUEUED;
      workflowRunId: string;
      meta: WorkflowRunMeta;
      step: WorkflowStep;
      resourceType: string;
      priority: number;
    }>
  | WithOptionalParent<{
      type: typeof WorkflowEventTypes.STEP_START;
      workflowRunId: string;
      meta: WorkflowRunMeta;
      step: WorkflowStep;
    }>
  | WithOptionalParent<{
      type: typeof WorkflowEventTypes.STEP_FINISHED;
      workflowRunId: string;
      meta: WorkflowRunMeta;
      step: WorkflowStep;
      result: ExecutionResult;
    }>
  | WithOptionalParent<{
      type: typeof WorkflowEventTypes.PLUGIN_LOG;
      workflowRunId: string;
      meta: WorkflowRunMeta;
      step: WorkflowStep;
      log: PluginLogEntry;
    }>;

/**
 * 工作流生命周期观察者；调用方用于日志、持久化、链路追踪等
 */
export interface WorkflowObserver {
  /** 支持 async；executor 内 await，保证调用方顺序可控 */
  onEvent?(event: WorkflowLifecycleEvent): void | Promise<void>;
}
