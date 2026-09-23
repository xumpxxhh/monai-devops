import type {
  AttemptStatus,
  ExecutionCheckpoint,
  ExecutionIdentity,
  RetryPolicy,
} from '@monai-devops/core-engine';

export interface CreateExecutionJobInput {
  execution: ExecutionIdentity;
  runId: string;
  stepId: string;
  idempotencyKey: string;
  retryPolicy: RetryPolicy;
}

export interface RecoverableAttempt {
  attemptId: string;
  jobId: string;
  attempt: number;
  status: AttemptStatus;
  leaseOwner?: string;
  leaseExpiresAt?: Date;
}

export interface ExecutionRepository {
  ensureJob(input: CreateExecutionJobInput): Promise<void>;
  ensureAttempt(execution: ExecutionIdentity): Promise<void>;
  acquireLease(
    attemptId: string,
    ownerId: string,
    token: string,
    expiresAt: Date,
  ): Promise<boolean>;
  heartbeat(attemptId: string, token: string, expiresAt: Date): Promise<boolean>;
  transitionAttempt(
    attemptId: string,
    from: AttemptStatus,
    to: AttemptStatus,
    reason?: unknown,
  ): Promise<boolean>;
  saveCheckpoint(checkpoint: ExecutionCheckpoint): Promise<void>;
  listRecoverable(now: Date): Promise<RecoverableAttempt[]>;
}

export const EXECUTION_REPOSITORY = Symbol('EXECUTION_REPOSITORY');
