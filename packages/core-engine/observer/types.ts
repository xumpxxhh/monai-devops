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
import type { PluginLogEntry } from '@monai-devops/plugin-sdk';
import { WorkflowEventTypes } from './event-types.js';

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
      type: typeof WorkflowEventTypes.WORKFLOW_START;
      meta: WorkflowRunMeta;
      workflow: WorkflowDefinition;
    }
  | {
      type: typeof WorkflowEventTypes.WORKFLOW_FINISHED;
      meta: WorkflowRunMeta;
      result: WorkflowRunResult;
    }
  | {
      type: typeof WorkflowEventTypes.STEP_QUEUED;
      meta: WorkflowRunMeta;
      step: WorkflowStep;
      resourceType: string;
      priority: number;
    }
  | {
      type: typeof WorkflowEventTypes.STEP_START;
      meta: WorkflowRunMeta;
      step: WorkflowStep;
    }
  | {
      type: typeof WorkflowEventTypes.STEP_FINISHED;
      meta: WorkflowRunMeta;
      step: WorkflowStep;
      result: ExecutionResult;
    }
  | {
      type: typeof WorkflowEventTypes.PLUGIN_LOG;
      meta: WorkflowRunMeta;
      step: WorkflowStep;
      log: PluginLogEntry;
    };

/**
 * 工作流生命周期观察者；调用方用于日志、持久化、链路追踪等
 */
export interface WorkflowObserver {
  /** 支持 async；executor 内 await，保证调用方顺序可控 */
  onEvent?(event: WorkflowLifecycleEvent): void | Promise<void>;
}
