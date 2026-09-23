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

export type ExecutionControlType = 'pause' | 'resume' | 'cancel';
export type ExecutionControlStatus = 'pending' | 'applied' | 'rejected';

export interface ExecutionControlCommand {
  commandId: string;
  runId: string;
  type: ExecutionControlType;
  payload: Record<string, unknown>;
  status: ExecutionControlStatus;
  claimedBy?: string;
  claimedAt?: Date;
  requestedAt: Date;
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
  setJobStatus(jobId: string, status: AttemptStatus): Promise<void>;
  saveCheckpoint(checkpoint: ExecutionCheckpoint): Promise<void>;
  listRecoverable(now: Date): Promise<RecoverableAttempt[]>;
  enqueueControl(command: ExecutionControlCommand): Promise<void>;
  listClaimableControls(staleBefore: Date, limit: number): Promise<ExecutionControlCommand[]>;
  claimControl(commandId: string, ownerId: string, staleBefore: Date): Promise<boolean>;
  completeControl(
    commandId: string,
    ownerId: string,
    status: Exclude<ExecutionControlStatus, 'pending'>,
    error?: string,
  ): Promise<boolean>;
}

export const EXECUTION_REPOSITORY = Symbol('EXECUTION_REPOSITORY');
