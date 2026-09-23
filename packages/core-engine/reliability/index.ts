import type { ExecutionIdentity } from '../executor/execution-identity.js';

export const AttemptStatuses = {
  QUEUED: 'queued',
  LEASED: 'leased',
  RUNNING: 'running',
  WAITING: 'waiting',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TIMED_OUT: 'timed_out',
} as const;

export type AttemptStatus = (typeof AttemptStatuses)[keyof typeof AttemptStatuses];

const TRANSITIONS: Record<AttemptStatus, ReadonlySet<AttemptStatus>> = {
  queued: new Set(['leased', 'cancelled']),
  leased: new Set(['running', 'queued', 'cancelled', 'timed_out']),
  running: new Set(['waiting', 'succeeded', 'failed', 'cancelled', 'timed_out']),
  waiting: new Set(['leased', 'cancelled', 'timed_out']),
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
  if (!Number.isInteger(contract.retryPolicy.maxAttempts) || contract.retryPolicy.maxAttempts < 1) {
    throw new Error('retryPolicy.maxAttempts must be a positive integer');
  }
  if (!Number.isFinite(contract.retryPolicy.backoffMs) || contract.retryPolicy.backoffMs < 0) {
    throw new Error('retryPolicy.backoffMs must be non-negative');
  }
}
