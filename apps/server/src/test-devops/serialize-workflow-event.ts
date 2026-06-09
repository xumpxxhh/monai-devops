import type {
  ExecutionResult,
  WorkflowLifecycleEvent,
  WorkflowRunResult,
} from '@monai-devops/core-engine';

interface SerializedError {
  name: string;
  message: string;
}

type SerializedExecutionResult = Omit<ExecutionResult, 'error'> & {
  error?: SerializedError;
};

type SerializedWorkflowRunResult = Omit<WorkflowRunResult, 'results'> & {
  results: SerializedExecutionResult[];
};

export type SerializedWorkflowLifecycleEvent = Record<string, unknown>;

function serializeError(error: Error): SerializedError {
  return { name: error.name, message: error.message };
}

function serializeExecutionResult(result: ExecutionResult): SerializedExecutionResult {
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

  return event;
}
