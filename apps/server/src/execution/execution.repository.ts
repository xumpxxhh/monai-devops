import type {
  AttemptStatus,
  ExecutionCheckpoint,
  ExecutionIdentity,
  RetryPolicy,
  ExecutionWakeCondition,
  ExecutorDispatchV1,
  ExecutorLeaseClaimV1,
  ExecutorMessageDecision,
} from '@monai-devops/core-engine';
import type { PluginResult } from '@monai-devops/plugin-sdk';

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
  idempotencyKey?: string;
  checkpoint?: ExecutionCheckpoint;
  attempts: Array<{
    attempt: number;
    status: AttemptStatus;
    reason?: unknown;
    wakeReadyAt?: Date;
    wakePayload?: unknown;
  }>;
}

export interface RegisterExecutionWaitInput {
  execution: ExecutionIdentity;
  leaseToken: string;
  checkpoint: ExecutionCheckpoint;
  condition: ExecutionWakeCondition;
}

export type WorkerTerminalResult =
  | { kind: 'complete'; result: PluginResult }
  | { kind: 'wait'; result: PluginResult };

export interface ClaimedWorkerDispatch {
  dispatch: ExecutorDispatchV1;
  claim: ExecutorLeaseClaimV1;
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
  /** Only the live lease holder may move a claimed Attempt into running. */
  startLeasedAttempt(attemptId: string, token: string): Promise<boolean>;
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
  /** 原子检查过期时间并将 Attempt/Job 一起转为 timed_out，防止与续租竞态。 */
  timeoutExpiredAttempt(attemptId: string, now: Date, reason: unknown): Promise<boolean>;
  listJobsForRun(runId: string): Promise<RecoveryJob[]>;
  /** Under an active Run lease, project settled worker results missed before a server crash. */
  projectSettledWorkerAttempts(runId: string, runLeaseToken: string): Promise<number>;
  /** Bind the server-approved immutable dispatch to a queued Attempt under Run ownership. */
  registerWorkerDispatch(request: ExecutorDispatchV1, runLeaseToken: string): Promise<boolean>;
  claimWorkerDispatch(
    workerId: string,
    leaseTtlMs: number,
  ): Promise<ClaimedWorkerDispatch | undefined>;
  acceptRegisteredWorkerMessage(
    message: unknown,
    leaseTtlMs: number,
  ): Promise<ExecutorMessageDecision>;
  /** Only returns a terminal inbox receipt consistent with the authoritative Attempt/Job. */
  readWorkerTerminal(execution: ExecutionIdentity): Promise<WorkerTerminalResult | undefined>;
  /** Under the live Run owner, race an expired worker lease against heartbeat/terminal CAS. */
  timeoutExpiredWorkerAttempt(
    execution: ExecutionIdentity,
    runId: string,
    runLeaseToken: string,
  ): Promise<boolean>;
  registerWait(input: RegisterExecutionWaitInput): Promise<boolean>;
  /** Read-only confirmation that the same worker wait was already atomically persisted. */
  confirmRegisteredWorkerWait(
    execution: ExecutionIdentity,
    checkpoint: ExecutionCheckpoint,
    condition: ExecutionWakeCondition,
  ): Promise<boolean>;
  signalWait(attemptId: string, key: string, payload: unknown, now: Date): Promise<boolean>;
  wakeDueTimers(now: Date): Promise<number>;
  expireWaits(now: Date): Promise<number>;
  enqueueControl(command: ExecutionControlCommand): Promise<void>;
  listClaimableControls(staleBefore: Date, limit: number): Promise<ExecutionControlCommand[]>;
  claimControl(commandId: string, ownerId: string, staleBefore: Date): Promise<boolean>;
  releaseControlClaim(commandId: string, ownerId: string): Promise<boolean>;
  /** 原子取消无活跃 Run owner 的 waiting/paused Run 及其未结算 Attempt/Job。 */
  cancelWaitingRun(
    runId: string,
    mode: 'best-effort' | 'hard',
    status?: 'waiting' | 'paused',
  ): Promise<boolean>;
  completeControl(
    commandId: string,
    ownerId: string,
    status: Exclude<ExecutionControlStatus, 'pending'>,
    error?: string,
  ): Promise<boolean>;
}

export const EXECUTION_REPOSITORY = Symbol('EXECUTION_REPOSITORY');
