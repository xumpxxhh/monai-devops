const DEFAULT_ATTEMPT_DEADLINE_MS = 5 * 60_000;

/** Server-owned wall-clock limit for experimental remote attempts. */
export function resolveExecutorAttemptDeadlineMs(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_ATTEMPT_DEADLINE_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 10_000 || parsed > 24 * 60 * 60_000) {
    throw new Error('EXECUTOR_ATTEMPT_DEADLINE_MS must be an integer from 10000 to 86400000');
  }
  return parsed;
}

/** Hard cancel remains immediate unless an explicit cooperative grace is configured. */
export function resolveExecutorCancelGraceMs(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 30_000) {
    throw new Error('EXECUTOR_CANCEL_GRACE_MS must be an integer from 0 to 30000');
  }
  return parsed;
}
