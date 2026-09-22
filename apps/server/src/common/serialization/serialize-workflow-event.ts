import type {
  ExecutionResult,
  WorkflowLifecycleEvent,
  WorkflowRunResult,
} from '@monai-devops/core-engine';
import type { RunStatus } from '../../runs/runs.repository.js';

interface SerializedError {
  name: string;
  message: string;
}

export type SerializedExecutionResult = Omit<ExecutionResult, 'error'> & {
  error?: SerializedError;
};

export type SerializedWorkflowRunResult = Omit<WorkflowRunResult, 'results'> & {
  results: SerializedExecutionResult[];
};

/**
 * 可持久化的生命周期事件。
 *
 * `sequence` 来自 core-engine，表示首个源事件在顶层 Run 中的序号；连续流日志被
 * 合并时，`sequenceEnd` 表示该持久化 payload 覆盖到的最后一个源事件序号。
 * 两者都与数据库 `eventIndex` 独立，历史事件可以不包含这些字段。
 */
export type SerializedWorkflowLifecycleEvent = Record<string, unknown> & {
  sequence?: number;
  sequenceEnd?: number;
};

function serializeError(error: Error): SerializedError {
  return { name: error.name, message: error.message };
}

export function serializeExecutionResult(result: ExecutionResult): SerializedExecutionResult {
  if (!result.error) {
    return result;
  }

  const { error, ...rest } = result;
  return { ...rest, error: serializeError(error) };
}

export function serializeWorkflowRunResult(result: WorkflowRunResult): SerializedWorkflowRunResult {
  return {
    ...result,
    results: result.results.map(serializeExecutionResult),
  };
}

export function runStatusFromWorkflowResult(result: WorkflowRunResult): RunStatus {
  if (result.status === 'cancelled') return 'cancelled';
  if (result.status === 'failed') return 'failed';
  return 'finished';
}

export function serializeWorkflowEvent(
  event: WorkflowLifecycleEvent,
): SerializedWorkflowLifecycleEvent {
  if (event.type === 'step:finished') {
    return {
      ...event,
      result: serializeExecutionResult(event.result),
    };
  }

  if (event.type === 'workflow:finished') {
    return {
      ...event,
      result: serializeWorkflowRunResult(event.result),
    };
  }

  if (event.type === 'plugin:log') {
    return event;
  }

  return event;
}
