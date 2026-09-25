import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AttemptStatuses,
  validateWakeCondition,
  type AttemptStatus,
} from '@monai-devops/core-engine';
import { PrismaService } from '../prisma/prisma.service.js';
import { toInputJson } from '../prisma/prisma-json.js';
import type {
  CreateExecutionJobInput,
  ExecutionControlCommand,
  ExecutionRepository,
  RegisterExecutionWaitInput,
  RecoverableAttempt,
  RecoveryJob,
} from './execution.repository.js';
import type { ExecutionCheckpoint, ExecutionIdentity } from '@monai-devops/core-engine';

@Injectable()
export class PrismaExecutionRepository implements ExecutionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async ensureJob(input: CreateExecutionJobInput): Promise<void> {
    await this.prisma.executionJob.upsert({
      where: { jobId: input.execution.jobId },
      create: {
        jobId: input.execution.jobId,
        runId: input.runId,
        stepId: input.stepId,
        status: AttemptStatuses.QUEUED,
        idempotencyKey: input.idempotencyKey,
        retryPolicy: toInputJson(input.retryPolicy),
      },
      update: {},
    });
  }

  async ensureAttempt(execution: ExecutionIdentity): Promise<void> {
    await this.prisma.executionAttempt.upsert({
      where: { attemptId: execution.attemptId },
      create: {
        attemptId: execution.attemptId,
        jobId: execution.jobId,
        attempt: execution.attempt,
        status: AttemptStatuses.QUEUED,
      },
      update: {},
    });
  }

  async acquireLease(
    attemptId: string,
    ownerId: string,
    token: string,
    expiresAt: Date,
  ): Promise<boolean> {
    const now = new Date();
    const result = await this.prisma.executionAttempt.updateMany({
      where: {
        attemptId,
        OR: [
          { status: AttemptStatuses.QUEUED },
          { status: AttemptStatuses.WAITING, wakeReadyAt: { not: null } },
          {
            status: { in: [AttemptStatuses.LEASED, AttemptStatuses.RUNNING] },
            leaseExpiresAt: { lt: now },
          },
        ],
      },
      data: {
        status: AttemptStatuses.LEASED,
        leaseOwner: ownerId,
        leaseToken: token,
        leaseExpiresAt: expiresAt,
        heartbeatAt: now,
      },
    });
    return result.count === 1;
  }

  async heartbeat(attemptId: string, token: string, expiresAt: Date): Promise<boolean> {
    const result = await this.prisma.executionAttempt.updateMany({
      where: {
        attemptId,
        leaseToken: token,
        status: { in: [AttemptStatuses.LEASED, AttemptStatuses.RUNNING] },
      },
      data: { heartbeatAt: new Date(), leaseExpiresAt: expiresAt },
    });
    return result.count === 1;
  }

  async transitionAttempt(
    attemptId: string,
    from: AttemptStatus,
    to: AttemptStatus,
    reason?: unknown,
  ): Promise<boolean> {
    const now = new Date();
    const terminal =
      to === AttemptStatuses.SKIPPED ||
      to === AttemptStatuses.SUCCEEDED ||
      to === AttemptStatuses.FAILED ||
      to === AttemptStatuses.CANCELLED ||
      to === AttemptStatuses.TIMED_OUT;
    const result = await this.prisma.executionAttempt.updateMany({
      where: { attemptId, status: from },
      data: {
        status: to,
        ...(to === AttemptStatuses.RUNNING ? { startedAt: now } : {}),
        ...(terminal ? { finishedAt: now } : {}),
        ...(reason !== undefined ? { reason: toInputJson(reason) } : {}),
      },
    });
    return result.count === 1;
  }

  async setJobStatus(jobId: string, status: AttemptStatus): Promise<void> {
    await this.prisma.executionJob.update({ where: { jobId }, data: { status } });
  }

  async saveCheckpoint(checkpoint: ExecutionCheckpoint): Promise<void> {
    await this.prisma.executionJob.update({
      where: { jobId: checkpoint.jobId },
      data: { checkpoint: toInputJson(checkpoint) },
    });
  }

  async listRecoverable(now: Date): Promise<RecoverableAttempt[]> {
    const rows = await this.prisma.executionAttempt.findMany({
      where: {
        OR: [
          { status: AttemptStatuses.WAITING },
          {
            status: { in: [AttemptStatuses.LEASED, AttemptStatuses.RUNNING] },
            leaseExpiresAt: { lt: now },
          },
        ],
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({
      attemptId: row.attemptId,
      jobId: row.jobId,
      attempt: row.attempt,
      status: row.status as AttemptStatus,
      leaseOwner: row.leaseOwner ?? undefined,
      leaseExpiresAt: row.leaseExpiresAt ?? undefined,
      wakeReadyAt: row.wakeReadyAt ?? undefined,
    }));
  }

  async timeoutExpiredAttempt(attemptId: string, now: Date, reason: unknown): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const attempt = await tx.executionAttempt.findUnique({
        where: { attemptId },
        select: { jobId: true },
      });
      if (!attempt) return false;
      const changed = await tx.executionAttempt.updateMany({
        where: {
          attemptId,
          status: { in: [AttemptStatuses.LEASED, AttemptStatuses.RUNNING] },
          leaseExpiresAt: { lt: now },
          job: {
            run: {
              OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
            },
          },
        },
        data: {
          status: AttemptStatuses.TIMED_OUT,
          finishedAt: now,
          reason: toInputJson(reason),
          leaseOwner: null,
          leaseToken: null,
        },
      });
      if (changed.count !== 1) return false;
      await tx.executionJob.update({
        where: { jobId: attempt.jobId },
        data: { status: AttemptStatuses.TIMED_OUT },
      });
      return true;
    });
  }

  async listJobsForRun(runId: string): Promise<RecoveryJob[]> {
    const rows = await this.prisma.executionJob.findMany({
      where: { runId },
      include: { attempts: { orderBy: { attempt: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({
      stepId: row.stepId,
      status: row.status as RecoveryJob['status'],
      idempotencyKey: row.idempotencyKey ?? undefined,
      checkpoint: (row.checkpoint as unknown as RecoveryJob['checkpoint']) ?? undefined,
      attempts: row.attempts.map((attempt) => ({
        attempt: attempt.attempt,
        status: attempt.status as RecoveryJob['status'],
        reason: attempt.reason ?? undefined,
      })),
    }));
  }

  async registerWait(input: RegisterExecutionWaitInput): Promise<boolean> {
    validateWakeCondition(input.condition);
    if (
      input.checkpoint.jobId !== input.execution.jobId ||
      input.checkpoint.sourceAttemptId !== input.execution.attemptId ||
      !Number.isInteger(input.checkpoint.version) ||
      input.checkpoint.version < 1
    ) {
      throw new Error('Checkpoint identity or version is invalid');
    }
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const job = await tx.executionJob.findUnique({ where: { jobId: input.execution.jobId } });
      if (!job) return false;
      const currentVersion =
        job.checkpoint && typeof job.checkpoint === 'object' && !Array.isArray(job.checkpoint)
          ? Number((job.checkpoint as Record<string, unknown>).version ?? 0)
          : 0;
      if (input.checkpoint.version <= currentVersion) return false;

      const changed = await tx.executionAttempt.updateMany({
        where: {
          attemptId: input.execution.attemptId,
          jobId: input.execution.jobId,
          status: AttemptStatuses.RUNNING,
          leaseToken: input.leaseToken,
          leaseExpiresAt: { gt: now },
        },
        data: {
          status: AttemptStatuses.WAITING,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          waitKind: input.condition.kind,
          wakeKey: input.condition.kind === 'signal' ? input.condition.key : null,
          wakeAt: input.condition.kind === 'timer' ? new Date(input.condition.wakeAt) : null,
          waitTimeoutAt: input.condition.timeoutAt ? new Date(input.condition.timeoutAt) : null,
          wakeReadyAt: null,
          wakePayload: Prisma.DbNull,
        },
      });
      if (changed.count !== 1) return false;
      await tx.executionJob.update({
        where: { jobId: input.execution.jobId },
        data: {
          status: AttemptStatuses.WAITING,
          checkpoint: toInputJson(input.checkpoint),
        },
      });
      return true;
    });
  }

  async signalWait(attemptId: string, key: string, payload: unknown, now: Date): Promise<boolean> {
    if (!key.trim()) return false;
    const result = await this.prisma.executionAttempt.updateMany({
      where: {
        attemptId,
        status: AttemptStatuses.WAITING,
        waitKind: 'signal',
        wakeKey: key,
        wakeReadyAt: null,
        OR: [{ waitTimeoutAt: null }, { waitTimeoutAt: { gt: now } }],
      },
      data: { wakeReadyAt: now, wakePayload: toInputJson(payload ?? {}) },
    });
    return result.count === 1;
  }

  async wakeDueTimers(now: Date): Promise<number> {
    const result = await this.prisma.executionAttempt.updateMany({
      where: {
        status: AttemptStatuses.WAITING,
        waitKind: 'timer',
        wakeAt: { lte: now },
        wakeReadyAt: null,
        OR: [{ waitTimeoutAt: null }, { waitTimeoutAt: { gt: now } }],
      },
      data: { wakeReadyAt: now },
    });
    return result.count;
  }

  async expireWaits(now: Date): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const due = await tx.executionAttempt.findMany({
        where: {
          status: AttemptStatuses.WAITING,
          wakeReadyAt: null,
          waitTimeoutAt: { lte: now },
        },
        select: { attemptId: true, jobId: true },
      });
      let expired = 0;
      for (const attempt of due) {
        const changed = await tx.executionAttempt.updateMany({
          where: {
            attemptId: attempt.attemptId,
            status: AttemptStatuses.WAITING,
            wakeReadyAt: null,
            waitTimeoutAt: { lte: now },
          },
          data: {
            status: AttemptStatuses.TIMED_OUT,
            finishedAt: now,
            reason: toInputJson({
              code: 'wait_timeout',
              category: 'infrastructure',
              message: 'Execution wait timed out',
            }),
          },
        });
        if (changed.count !== 1) continue;
        await tx.executionJob.update({
          where: { jobId: attempt.jobId },
          data: { status: AttemptStatuses.TIMED_OUT },
        });
        expired += 1;
      }
      return expired;
    });
  }

  async enqueueControl(command: ExecutionControlCommand): Promise<void> {
    await this.prisma.executionControlCommand.create({
      data: {
        commandId: command.commandId,
        runId: command.runId,
        type: command.type,
        payload: toInputJson(command.payload),
        status: command.status,
        requestedAt: command.requestedAt,
      },
    });
  }

  async listClaimableControls(
    staleBefore: Date,
    limit: number,
  ): Promise<ExecutionControlCommand[]> {
    const rows = await this.prisma.executionControlCommand.findMany({
      where: {
        status: 'pending',
        OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }],
      },
      orderBy: { requestedAt: 'asc' },
      take: limit,
    });
    return rows.map((row) => ({
      commandId: row.commandId,
      runId: row.runId,
      type: row.type as ExecutionControlCommand['type'],
      payload: row.payload as Record<string, unknown>,
      status: row.status as ExecutionControlCommand['status'],
      claimedBy: row.claimedBy ?? undefined,
      claimedAt: row.claimedAt ?? undefined,
      requestedAt: row.requestedAt,
    }));
  }

  async claimControl(commandId: string, ownerId: string, staleBefore: Date): Promise<boolean> {
    const result = await this.prisma.executionControlCommand.updateMany({
      where: {
        commandId,
        status: 'pending',
        OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }],
      },
      data: { claimedBy: ownerId, claimedAt: new Date() },
    });
    return result.count === 1;
  }

  async releaseControlClaim(commandId: string, ownerId: string): Promise<boolean> {
    const result = await this.prisma.executionControlCommand.updateMany({
      where: { commandId, status: 'pending', claimedBy: ownerId },
      data: { claimedBy: null, claimedAt: null },
    });
    return result.count === 1;
  }

  async completeControl(
    commandId: string,
    ownerId: string,
    status: 'applied' | 'rejected',
    error?: string,
  ): Promise<boolean> {
    const result = await this.prisma.executionControlCommand.updateMany({
      where: { commandId, status: 'pending', claimedBy: ownerId },
      data: {
        status,
        completedAt: new Date(),
        error: error ?? null,
      },
    });
    return result.count === 1;
  }
}
