/**
 * 工作流生命周期可观测性类型
 * @module observer/types
 */

import type {
  ExecutionContext,
  ExecutionResult,
  WorkflowDefinition,
  WorkflowRunResult,
  WorkflowStep,
} from '../executor/types.js';

/**
 * 单次工作流运行的元数据
 */
export interface WorkflowRunMeta {
  runId: string;
  workflowId: string;
  traceId?: string;
  /** 调用方 runWorkflow 传入的其余 ExecutionContext 字段 */
  context?: Partial<ExecutionContext>;
}

/**
 * 工作流生命周期事件（discriminated union）
 */
export type WorkflowLifecycleEvent =
  | {
      type: 'workflow:start';
      meta: WorkflowRunMeta;
      workflow: WorkflowDefinition;
    }
  | {
      type: 'workflow:finished';
      meta: WorkflowRunMeta;
      result: WorkflowRunResult;
    }
  | {
      type: 'step:start';
      meta: WorkflowRunMeta;
      step: WorkflowStep;
    }
  | {
      type: 'step:finished';
      meta: WorkflowRunMeta;
      step: WorkflowStep;
      result: ExecutionResult;
    };

/**
 * 工作流生命周期观察者；调用方用于日志、持久化、链路追踪等
 */
export interface WorkflowObserver {
  /** 支持 async；executor 内 await，保证调用方顺序可控 */
  onEvent?(event: WorkflowLifecycleEvent): void | Promise<void>;
}
