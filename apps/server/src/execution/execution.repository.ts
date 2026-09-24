import type {
  AttemptStatus,
  ExecutionCheckpoint,
  ExecutionIdentity,
  RetryPolicy,
  ExecutionWakeCondition,
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
  wakeReadyAt?: Date;
}

/** 构建 Run 恢复快照所需的持久化 Job/Attempt 视图。 */
export interface RecoveryJob {
  stepId: string;
  status: AttemptStatus;
  checkpoint?: ExecutionCheckpoint;
  attempts: Array<{
    attempt: number;
    status: AttemptStatus;
    reason?: unknown;
  }>;
}

export interface RegisterExecutionWaitInput {
  execution: ExecutionIdentity;
  leaseToken: string;
  checkpoint: ExecutionCheckpoint;
  condition: ExecutionWakeCondition;
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
  listJobsForRun(runId: string): Promise<RecoveryJob[]>;
  registerWait(input: RegisterExecutionWaitInput): Promise<boolean>;
  signalWait(attemptId: string, key: string, payload: unknown, now: Date): Promise<boolean>;
  wakeDueTimers(now: Date): Promise<number>;
  expireWaits(now: Date): Promise<number>;
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
