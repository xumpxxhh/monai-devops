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

export type SerializedWorkflowLifecycleEvent = Record<string, unknown>;

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
