export interface ExecutionIdentity {
  jobId: string;
  attemptId: string;
  attempt: number;
}

export function createExecutionIdentity(
  workflowRunId: string,
  stepId: string,
  attempt = 0,
): ExecutionIdentity {
  const jobId = `${workflowRunId}/${stepId}`;
  return {
    jobId,
    attemptId: `${jobId}/attempt-${attempt}`,
    attempt,
  };
}
