import type { ExecutionIdentity } from '../executor/execution-identity.js';
import type { ExecutionResult } from '../executor/types.js';

export const AttemptStatuses = {
  QUEUED: 'queued',
  LEASED: 'leased',
  RUNNING: 'running',
  WAITING: 'waiting',
  SKIPPED: 'skipped',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TIMED_OUT: 'timed_out',
} as const;

export type AttemptStatus = (typeof AttemptStatuses)[keyof typeof AttemptStatuses];

const TRANSITIONS: Record<AttemptStatus, ReadonlySet<AttemptStatus>> = {
  queued: new Set(['leased', 'skipped', 'cancelled']),
  leased: new Set(['running', 'queued', 'skipped', 'cancelled', 'timed_out']),
  running: new Set(['waiting', 'skipped', 'succeeded', 'failed', 'cancelled', 'timed_out']),
  waiting: new Set(['leased', 'cancelled', 'timed_out']),
  skipped: new Set(),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  timed_out: new Set(),
};

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: number;
  maxBackoffMs?: number;
}

export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze({
  maxAttempts: 1,
  backoffMs: 0,
});

export interface AttemptLease {
  attemptId: string;
  ownerId: string;
  token: string;
  expiresAt: string;
  heartbeatAt: string;
}

export interface ExecutionCheckpoint {
  jobId: string;
  sourceAttemptId: string;
  version: number;
  payload: unknown;
  createdAt: string;
}

export type ExecutionWakeCondition =
  | { kind: 'signal'; key: string; timeoutAt?: string }
  | { kind: 'timer'; wakeAt: string; timeoutAt?: string };

export function validateWakeCondition(condition: ExecutionWakeCondition): void {
  if (condition.kind === 'signal') {
    if (!condition.key.trim()) throw new Error('wake condition key must not be empty');
  } else if (condition.kind === 'timer') {
    if (!Number.isFinite(Date.parse(condition.wakeAt))) {
      throw new Error('wakeAt must be a valid timestamp');
    }
  } else {
    throw new Error('wake condition kind must be signal or timer');
  }
  if (condition.timeoutAt !== undefined && !Number.isFinite(Date.parse(condition.timeoutAt))) {
    throw new Error('timeoutAt must be a valid timestamp');
  }
}

export interface ReliableExecutionContract {
  execution: ExecutionIdentity;
  idempotencyKey: string;
  retryPolicy: RetryPolicy;
}

export function isAttemptTerminal(status: AttemptStatus): boolean {
  return TRANSITIONS[status].size === 0;
}

export function canTransitionAttempt(from: AttemptStatus, to: AttemptStatus): boolean {
  return TRANSITIONS[from].has(to);
}

export function assertAttemptTransition(from: AttemptStatus, to: AttemptStatus): void {
  if (!canTransitionAttempt(from, to)) {
    throw new Error(`Invalid attempt transition: ${from} -> ${to}`);
  }
}

export function validateReliableExecutionContract(contract: ReliableExecutionContract): void {
  if (!contract.idempotencyKey.trim()) {
    throw new Error('idempotencyKey must not be empty');
  }
  validateRetryPolicy(contract.retryPolicy);
}

export function validateRetryPolicy(policy: RetryPolicy): void {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new Error('retryPolicy.maxAttempts must be a positive integer');
  }
  if (!Number.isFinite(policy.backoffMs) || policy.backoffMs < 0) {
    throw new Error('retryPolicy.backoffMs must be non-negative');
  }
  if (
    policy.maxBackoffMs !== undefined &&
    (!Number.isFinite(policy.maxBackoffMs) || policy.maxBackoffMs < policy.backoffMs)
  ) {
    throw new Error('retryPolicy.maxBackoffMs must be greater than or equal to backoffMs');
  }
}

export function resolveRetryPolicy(policy?: RetryPolicy): RetryPolicy {
  const resolved = policy ?? DEFAULT_RETRY_POLICY;
  validateRetryPolicy(resolved);
  return resolved;
}

export function retryBackoffMs(policy: RetryPolicy, completedAttempt: number): number {
  const exponential = policy.backoffMs * 2 ** completedAttempt;
  return Math.min(exponential, policy.maxBackoffMs ?? exponential);
}

export function shouldRetryExecution(
  result: ExecutionResult,
  policy: RetryPolicy,
  completedAttempt: number,
): boolean {
  return (
    completedAttempt + 1 < policy.maxAttempts &&
    result.status === 'failed' &&
    result.reason?.retryable === true
  );
}
