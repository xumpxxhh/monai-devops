import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Prisma } from '@prisma/client';
import {
  AttemptStatuses,
  EXECUTOR_PROTOCOL_VERSION,
  EXECUTOR_DATA_MAX_BYTES,
  EXECUTOR_INLINE_RESULT_MAX_BYTES,
  isExecutorObjectRef,
  assessExecutorMessage,
  resolveRetryPolicy,
  validateExecutorDispatch,
  validateWakeCondition,
  type AttemptStatus,
  type ExecutorDispatchV1,
  type ExecutorMessageDecision,
  type ExecutorMessageV1,
  type ExecutorObjectRefV1,
  type WorkflowDefinition,
} from '@monai-devops/core-engine';
import { PrismaService } from '../prisma/prisma.service.js';
import { toInputJson } from '../prisma/prisma-json.js';
import type {
  CreateExecutionJobInput,
  ClaimedWorkerDispatch,
  DevelopmentAttemptView,
  ExecutionControlCommand,
  ExecutionRepository,
  RegisterExecutionWaitInput,
  RecoverableAttempt,
  RecoveryJob,
  WorkerTerminalResult,
  WorkerLogReceipt,
  WorkerPluginOffer,
} from './execution.repository.js';
import type {
  ExecutionCheckpoint,
  ExecutionIdentity,
  ExecutionWakeCondition,
} from '@monai-devops/core-engine';
import { MAX_WORKER_LOG_EVENTS, validWorkerEvent } from './worker-event-policy.js';

@Injectable()
export class PrismaExecutionRepository implements ExecutionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async storeWorkerObject(
    workerId: string,
    execution: ExecutionIdentity,
    leaseToken: string,
    kind: 'result' | 'log',
    content: Buffer,
  ): Promise<ExecutorObjectRefV1 | undefined> {
    const minimum = kind === 'result' ? EXECUTOR_INLINE_RESULT_MAX_BYTES : 4_096;
    if (content.length <= minimum || content.length > EXECUTOR_DATA_MAX_BYTES) {
      return undefined;
    }
    if (kind === 'result') {
      try {
        const value = JSON.parse(content.toString('utf8')) as Record<string, unknown>;
        if (
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          typeof value.success !== 'boolean'
        )
          return undefined;
      } catch {
        return undefined;
      }
    }
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ attemptId: string }>>`
        SELECT attempt."attempt_id" AS "attemptId"
        FROM "execution_attempts" AS attempt
        JOIN "execution_jobs" AS job ON job."job_id" = attempt."job_id"
        JOIN "runs" AS run ON run."run_id" = job."run_id"
        WHERE attempt."attempt_id" = ${execution.attemptId}
          AND attempt."job_id" = ${execution.jobId}
          AND attempt."attempt" = ${execution.attempt}
          AND attempt."status" = ${AttemptStatuses.RUNNING}
          AND attempt."lease_owner" = ${workerId}
          AND attempt."lease_token" = ${leaseToken}
          AND attempt."lease_expires_at" > clock_timestamp()
          AND (attempt."dispatch"->>'deadlineAt' IS NULL OR (attempt."dispatch"->>'deadlineAt')::timestamptz > clock_timestamp())
          AND run."status" = 'running'
          AND run."is_active" = TRUE
        FOR UPDATE OF attempt
      `;
      if (rows.length !== 1) return undefined;
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000);
      const objectId = randomUUID();
      const sha256 = createHash('sha256').update(content).digest('hex');
      await tx.executorObject.create({
        data: {
          objectId,
          attemptId: execution.attemptId,
          workerId,
          kind,
          content: Uint8Array.from(content),
          contentType: kind === 'result' ? 'application/json' : 'text/plain',
          sizeBytes: content.length,
          sha256,
          expiresAt,
        },
      });
      return {
        version: 1,
        objectId,
        kind,
        contentType: kind === 'result' ? 'application/json' : 'text/plain',
        sizeBytes: content.length,
        sha256,
        expiresAt: expiresAt.toISOString(),
      };
    });
  }

  async readWorkerObject(
    workerId: string,
    objectId: string,
  ): Promise<{ ref: ExecutorObjectRefV1; content: Buffer } | undefined> {
    const object = await this.prisma.executorObject.findFirst({
      where: { objectId, workerId, expiresAt: { gt: new Date() } },
    });
    if (!object) return undefined;
    return {
      ref: {
        version: 1,
        objectId,
        kind: object.kind as 'result' | 'log',
        contentType: object.contentType as 'application/json' | 'text/plain',
        sizeBytes: object.sizeBytes,
        sha256: object.sha256,
        expiresAt: object.expiresAt.toISOString(),
      },
      content: Buffer.from(object.content),
    };
  }

  async readDevelopmentRunObject(
    runId: string,
    objectId: string,
  ): Promise<{ ref: ExecutorObjectRefV1; content: Buffer } | undefined> {
    const object = await this.prisma.executorObject.findFirst({
      where: { objectId, expiresAt: { gt: new Date() }, attempt: { job: { runId } } },
    });
    if (!object) return undefined;
    return {
      ref: {
        version: 1,
        objectId,
        kind: object.kind as 'result' | 'log',
        contentType: object.contentType as 'application/json' | 'text/plain',
        sizeBytes: object.sizeBytes,
        sha256: object.sha256,
        expiresAt: object.expiresAt.toISOString(),
      },
      content: Buffer.from(object.content),
    };
  }

  async cleanupExpiredWorkerObjects(now: Date): Promise<number> {
    return (await this.prisma.executorObject.deleteMany({ where: { expiresAt: { lte: now } } }))
      .count;
  }

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

  async registerWorkerDispatch(
    request: ExecutorDispatchV1,
    runLeaseToken: string,
  ): Promise<boolean> {
    validateExecutorDispatch(request);
    const dispatch = JSON.stringify(request);
    const changed = await this.prisma.$executeRaw`
      UPDATE "execution_attempts" AS attempt
      SET "dispatch" = ${dispatch}::jsonb
      WHERE attempt."attempt_id" = ${request.execution.attemptId}
        AND attempt."job_id" = ${request.execution.jobId}
        AND attempt."attempt" = ${request.execution.attempt}
        AND attempt."status" = ${AttemptStatuses.QUEUED}
        AND attempt."dispatch" IS NULL
        AND EXISTS (
          SELECT 1 FROM "execution_jobs" AS job
          JOIN "runs" AS run ON run."run_id" = job."run_id"
          WHERE job."job_id" = attempt."job_id"
            AND job."run_id" = ${request.runId}
            AND job."step_id" = ${request.stepId}
            AND job."idempotency_key" = ${request.idempotencyKey}
            AND job."status" = ${AttemptStatuses.QUEUED}
            AND run."workflow_id" = ${request.workflowId}
            AND run."status" = 'running'
            AND run."is_active" = TRUE
            AND run."lease_token" = ${runLeaseToken}
            AND run."lease_expires_at" > clock_timestamp()
        )
    `;
    return changed === 1;
  }

  async claimWorkerDispatch(
    workerId: string,
    leaseTtlMs: number,
    plugins: WorkerPluginOffer[],
  ): Promise<ClaimedWorkerDispatch | undefined> {
    if (
      !workerId.trim() ||
      workerId.length > 128 ||
      !Number.isInteger(leaseTtlMs) ||
      leaseTtlMs < 3_000 ||
      !Array.isArray(plugins) ||
      plugins.length === 0
    ) {
      throw new Error('Invalid worker claim');
    }
    const token = randomUUID();
    const offered = JSON.stringify(plugins);
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{
          attemptId: string;
          jobId: string;
          dispatch: unknown;
          messageSequence: number;
          leaseExpiresAt: Date;
        }>
      >`
        WITH candidate AS (
          SELECT attempt."attempt_id"
          FROM "execution_attempts" AS attempt
          JOIN "execution_jobs" AS job ON job."job_id" = attempt."job_id"
          JOIN "runs" AS run ON run."run_id" = job."run_id"
          WHERE attempt."status" = ${AttemptStatuses.QUEUED}
            AND attempt."dispatch" IS NOT NULL
            AND job."status" = ${AttemptStatuses.QUEUED}
            AND run."status" = 'running'
            AND run."is_active" = TRUE
            AND run."lease_token" IS NOT NULL
            AND run."lease_expires_at" > clock_timestamp()
            AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(${offered}::jsonb) AS offer
              WHERE offer->>'name' = (attempt."dispatch"->'plugin'->>'name')
                AND offer->>'version' = (attempt."dispatch"->'plugin'->>'version')
                AND (attempt."dispatch"->'requiredCapabilities') <@ (offer->'capabilities')
            )
          ORDER BY attempt."created_at"
          FOR UPDATE OF attempt SKIP LOCKED
          LIMIT 1
        )
        UPDATE "execution_attempts" AS attempt
        SET "status" = ${AttemptStatuses.RUNNING},
            "lease_owner" = ${workerId},
            "lease_token" = ${token},
            "lease_expires_at" = clock_timestamp() + (${leaseTtlMs} * INTERVAL '1 millisecond'),
            "heartbeat_at" = clock_timestamp(),
            "started_at" = COALESCE(attempt."started_at", clock_timestamp())
        FROM candidate
        WHERE attempt."attempt_id" = candidate."attempt_id"
        RETURNING attempt."attempt_id" AS "attemptId", attempt."job_id" AS "jobId",
                  attempt."dispatch", attempt."message_sequence" AS "messageSequence",
                  attempt."lease_expires_at" AS "leaseExpiresAt"
      `;
      const row = rows[0];
      if (!row) return undefined;
      const job = await tx.executionJob.updateMany({
        where: { jobId: row.jobId, status: AttemptStatuses.QUEUED },
        data: { status: AttemptStatuses.RUNNING },
      });
      if (job.count !== 1) throw new Error(`Worker claim Job mismatch: ${row.jobId}`);
      validateExecutorDispatch(row.dispatch);
      return {
        dispatch: row.dispatch,
        claim: {
          protocolVersion: EXECUTOR_PROTOCOL_VERSION,
          execution: row.dispatch.execution,
          workerId,
          leaseToken: token,
          leaseExpiresAt: row.leaseExpiresAt.toISOString(),
          nextSequence: row.messageSequence + 1,
        },
      };
    });
  }

  async acceptRegisteredWorkerMessage(
    message: unknown,
    leaseTtlMs: number,
    workerId?: string,
  ): Promise<ExecutorMessageDecision> {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return { accepted: false, code: 'invalid_payload' };
    }
    const execution = (message as Record<string, unknown>).execution;
    if (!execution || typeof execution !== 'object' || Array.isArray(execution)) {
      return { accepted: false, code: 'invalid_identity' };
    }
    const attemptId = (execution as Record<string, unknown>).attemptId;
    if (typeof attemptId !== 'string' || !attemptId.trim()) {
      return { accepted: false, code: 'invalid_identity' };
    }
    const attempt = await this.prisma.executionAttempt.findUnique({
      where: { attemptId },
      select: { dispatch: true },
    });
    if (!attempt?.dispatch) return { accepted: false, code: 'invalid_identity' };
    validateExecutorDispatch(attempt.dispatch);
    return this.acceptWorkerMessage(attempt.dispatch, message, leaseTtlMs, workerId);
  }

  async acquireLease(
    attemptId: string,
    ownerId: string,
    token: string,
    expiresAt: Date,
  ): Promise<boolean> {
    const now = new Date();
    if (expiresAt <= now) return false;
    const result = await this.prisma.executionAttempt.updateMany({
      where: {
        attemptId,
        OR: [
          { status: AttemptStatuses.QUEUED },
          { status: AttemptStatuses.WAITING, wakeReadyAt: { not: null } },
          {
            status: { in: [AttemptStatuses.LEASED, AttemptStatuses.RUNNING] },
            leaseExpiresAt: { lt: now },
            cancelGraceUntil: null,
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
    const now = new Date();
    if (expiresAt <= now) return false;
    const result = await this.prisma.executionAttempt.updateMany({
      where: {
        attemptId,
        leaseToken: token,
        status: { in: [AttemptStatuses.LEASED, AttemptStatuses.RUNNING] },
        leaseExpiresAt: { gt: now },
      },
      data: { heartbeatAt: now, leaseExpiresAt: expiresAt },
    });
    return result.count === 1;
  }

  async startLeasedAttempt(attemptId: string, token: string): Promise<boolean> {
    const now = new Date();
    const result = await this.prisma.executionAttempt.updateMany({
      where: {
        attemptId,
        status: AttemptStatuses.LEASED,
        leaseToken: token,
        leaseExpiresAt: { gt: now },
      },
      data: { status: AttemptStatuses.RUNNING, startedAt: now },
    });
    return result.count === 1;
  }

  /** Durable, token-fenced worker inbox; orchestration/Run projection remains server-owned. */
  async acceptWorkerMessage(
    request: ExecutorDispatchV1,
    message: unknown,
    leaseTtlMs: number,
    workerId?: string,
  ): Promise<ExecutorMessageDecision> {
    validateExecutorDispatch(request);
    if (!Number.isInteger(leaseTtlMs) || leaseTtlMs < 3_000) {
      throw new Error('Invalid worker lease TTL');
    }
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const attempt = await tx.executionAttempt.findUnique({
        where: { attemptId: request.execution.attemptId },
        include: { job: true },
      });
      if (
        !attempt ||
        attempt.jobId !== request.execution.jobId ||
        attempt.attempt !== request.execution.attempt ||
        attempt.job.runId !== request.runId ||
        attempt.job.stepId !== request.stepId
      ) {
        return { accepted: false, code: 'invalid_identity' };
      }
      if (
        !attempt.dispatch ||
        !isDeepStrictEqual(attempt.dispatch, JSON.parse(JSON.stringify(request)))
      ) {
        return { accepted: false, code: 'invalid_payload' };
      }
      if (workerId && attempt.leaseOwner !== workerId) {
        return { accepted: false, code: 'invalid_identity' };
      }
      const fence = {
        execution: request.execution,
        leaseToken: attempt.leaseToken ?? '',
        leaseExpiresAt: attempt.leaseExpiresAt?.toISOString() ?? '',
        lastSequence: attempt.messageSequence,
        terminal: attempt.status !== AttemptStatuses.RUNNING,
      };
      const decision = assessExecutorMessage(request, fence, message, now);
      if (!decision.accepted) return decision;
      const progress = message as ExecutorMessageV1;
      if (attempt.cancelGraceUntil && progress.kind !== 'complete') {
        return { accepted: false, code: 'cancel_requested' };
      }
      if (!validWorkerEvent(progress)) return { accepted: false, code: 'invalid_payload' };
      if (progress.kind === 'complete') {
        if (
          Buffer.byteLength(JSON.stringify(progress.result), 'utf8') >
          EXECUTOR_INLINE_RESULT_MAX_BYTES
        ) {
          return { accepted: false, code: 'payload_too_large' };
        }
        const data = progress.result.data;
        if (data && typeof data === 'object' && !Array.isArray(data) && 'objectRef' in data) {
          const ref = (data as Record<string, unknown>).objectRef;
          if (!isExecutorObjectRef(ref) || Object.keys(data).length !== 1) {
            return { accepted: false, code: 'invalid_payload' };
          }
          const saved = await tx.executorObject.findFirst({
            where: {
              objectId: ref.objectId,
              attemptId: request.execution.attemptId,
              workerId: attempt.leaseOwner ?? '',
              expiresAt: { gt: now },
            },
          });
          if (
            !saved ||
            saved.sizeBytes !== ref.sizeBytes ||
            saved.sha256 !== ref.sha256 ||
            saved.expiresAt.toISOString() !== ref.expiresAt
          ) {
            return { accepted: false, code: 'invalid_payload' };
          }
        }
      }
      if (progress.kind === 'event') {
        const payload = progress.payload as Record<string, unknown>;
        if (payload.objectRef) {
          const ref = payload.objectRef as ExecutorObjectRefV1;
          const saved = await tx.executorObject.findFirst({
            where: {
              objectId: ref.objectId,
              attemptId: request.execution.attemptId,
              workerId: attempt.leaseOwner ?? '',
              kind: 'log',
              expiresAt: { gt: now },
            },
          });
          if (
            !saved ||
            saved.sizeBytes !== ref.sizeBytes ||
            saved.sha256 !== ref.sha256 ||
            saved.expiresAt.toISOString() !== ref.expiresAt
          ) {
            return { accepted: false, code: 'invalid_payload' };
          }
        }
        const logs = await tx.executionAttemptMessage.count({
          where: { attemptId: request.execution.attemptId, kind: 'event' },
        });
        if (logs >= MAX_WORKER_LOG_EVENTS) {
          return { accepted: false, code: 'payload_too_large' };
        }
      }
      const terminal = progress.kind === 'complete' || progress.kind === 'wait';
      const nextStatus =
        progress.kind === 'complete'
          ? progress.result.success
            ? AttemptStatuses.SUCCEEDED
            : AttemptStatuses.FAILED
          : progress.kind === 'wait'
            ? AttemptStatuses.WAITING
            : AttemptStatuses.RUNNING;
      const previousCheckpointVersion =
        attempt.job.checkpoint &&
        typeof attempt.job.checkpoint === 'object' &&
        !Array.isArray(attempt.job.checkpoint)
          ? Number((attempt.job.checkpoint as Record<string, unknown>).version ?? 0)
          : 0;
      if (
        progress.kind === 'wait' &&
        (!Number.isInteger(previousCheckpointVersion) || previousCheckpointVersion < 0)
      ) {
        return { accepted: false, code: 'invalid_payload' };
      }
      const update = Prisma.sql`
        UPDATE "execution_attempts"
        SET "message_sequence" = "message_sequence" + 1,
            "status" = ${nextStatus}
          ${
            progress.kind === 'heartbeat'
              ? Prisma.sql`, "heartbeat_at" = clock_timestamp(), "lease_expires_at" = clock_timestamp() + (${leaseTtlMs} * INTERVAL '1 millisecond')`
              : Prisma.empty
          }
          ${
            terminal ? Prisma.sql`, "lease_expires_at" = NULL, "heartbeat_at" = NULL` : Prisma.empty
          }
          ${progress.kind === 'complete' ? Prisma.sql`, "finished_at" = clock_timestamp()` : Prisma.empty}
        WHERE "attempt_id" = ${request.execution.attemptId}
          AND "job_id" = ${request.execution.jobId}
          AND "attempt" = ${request.execution.attempt}
          AND "status" = ${AttemptStatuses.RUNNING}
          AND "lease_token" = ${progress.leaseToken}
          ${workerId ? Prisma.sql`AND "lease_owner" = ${workerId}` : Prisma.empty}
          AND "lease_expires_at" > clock_timestamp()
          AND "message_sequence" = ${attempt.messageSequence}
          ${
            request.deadlineAt
              ? Prisma.sql`AND ${new Date(request.deadlineAt)} > clock_timestamp()`
              : Prisma.empty
          }
      `;
      const changed = await tx.$executeRaw(update);
      if (changed !== 1) {
        const current = await tx.executionAttempt.findUnique({
          where: { attemptId: request.execution.attemptId },
        });
        if (!current) return { accepted: false, code: 'invalid_identity' };
        return assessExecutorMessage(
          request,
          {
            execution: request.execution,
            leaseToken: current.leaseToken ?? '',
            leaseExpiresAt: current.leaseExpiresAt?.toISOString() ?? '',
            lastSequence: current.messageSequence,
            terminal: current.status !== AttemptStatuses.RUNNING,
          },
          message,
          new Date(),
        );
      }
      if (progress.kind === 'complete') {
        await tx.executionAttempt.update({
          where: { attemptId: request.execution.attemptId },
          data: { result: toInputJson(progress.result) },
        });
        await tx.executionJob.update({
          where: { jobId: request.execution.jobId },
          data: { status: nextStatus },
        });
      } else if (progress.kind === 'wait') {
        const checkpoint = {
          jobId: request.execution.jobId,
          sourceAttemptId: request.execution.attemptId,
          version: previousCheckpointVersion + 1,
          payload: progress.checkpoint,
          createdAt: now.toISOString(),
        };
        await tx.executionAttempt.update({
          where: { attemptId: request.execution.attemptId },
          data: {
            waitKind: progress.condition.kind,
            wakeKey: progress.condition.kind === 'signal' ? progress.condition.key : null,
            wakeAt:
              progress.condition.kind === 'timer' ? new Date(progress.condition.wakeAt) : null,
            waitTimeoutAt: progress.condition.timeoutAt
              ? new Date(progress.condition.timeoutAt)
              : null,
            wakeReadyAt: null,
            wakePayload: Prisma.DbNull,
          },
        });
        await tx.executionJob.update({
          where: { jobId: request.execution.jobId },
          data: { status: AttemptStatuses.WAITING, checkpoint: toInputJson(checkpoint) },
        });
      }
      await tx.executionAttemptMessage.create({
        data: {
          attemptId: request.execution.attemptId,
          sequence: progress.sequence,
          kind: progress.kind,
          eventType: progress.kind === 'event' ? progress.eventType : null,
          payloadVersion: progress.kind === 'event' ? progress.payloadVersion : null,
          payload:
            progress.kind === 'event'
              ? progress.payload === null
                ? Prisma.JsonNull
                : toInputJson(progress.payload)
              : progress.kind === 'complete'
                ? toInputJson(progress.result)
                : progress.kind === 'wait'
                  ? toInputJson({ checkpoint: progress.checkpoint, condition: progress.condition })
                  : undefined,
          occurredAt: new Date(progress.occurredAt),
          receivedAt: now,
        },
      });
      return decision;
    });
  }

  async readWorkerTerminal(
    execution: ExecutionIdentity,
  ): Promise<WorkerTerminalResult | undefined> {
    const attempt = await this.prisma.executionAttempt.findUnique({
      where: { attemptId: execution.attemptId },
      include: { job: true, workerMessages: { orderBy: { sequence: 'desc' }, take: 1 } },
    });
    if (
      !attempt ||
      attempt.jobId !== execution.jobId ||
      attempt.attempt !== execution.attempt ||
      attempt.messageSequence < 1
    ) {
      return undefined;
    }
    const receipt = attempt.workerMessages[0];
    if (!receipt || receipt.sequence !== attempt.messageSequence) return undefined;
    if (receipt.kind === 'complete') {
      if (
        !attempt.result ||
        typeof attempt.result !== 'object' ||
        Array.isArray(attempt.result) ||
        typeof attempt.result.success !== 'boolean' ||
        attempt.result.success !== (attempt.status === AttemptStatuses.SUCCEEDED) ||
        !isDeepStrictEqual(attempt.result, receipt.payload) ||
        (attempt.status !== AttemptStatuses.SUCCEEDED &&
          attempt.status !== AttemptStatuses.FAILED) ||
        attempt.job.status !== attempt.status
      ) {
        return undefined;
      }
      return {
        kind: 'complete',
        result: attempt.result as unknown as WorkerTerminalResult['result'],
      };
    }
    if (receipt.kind !== 'wait') return undefined;
    const payload = receipt.payload;
    const checkpoint = attempt.job.checkpoint;
    if (
      attempt.status !== AttemptStatuses.WAITING ||
      attempt.job.status !== AttemptStatuses.WAITING ||
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      !checkpoint ||
      typeof checkpoint !== 'object' ||
      Array.isArray(checkpoint)
    ) {
      return undefined;
    }
    const saved = checkpoint as Record<string, unknown>;
    const message = payload as Record<string, unknown>;
    if (
      saved.jobId !== execution.jobId ||
      saved.sourceAttemptId !== execution.attemptId ||
      !Number.isInteger(saved.version) ||
      !isDeepStrictEqual(saved.payload, message.checkpoint) ||
      !message.condition ||
      typeof message.condition !== 'object' ||
      Array.isArray(message.condition)
    ) {
      return undefined;
    }
    const condition = message.condition as ExecutionWakeCondition;
    try {
      validateWakeCondition(condition);
    } catch {
      return undefined;
    }
    if (
      attempt.waitKind !== condition.kind ||
      attempt.waitTimeoutAt?.getTime() !==
        (condition.timeoutAt ? new Date(condition.timeoutAt).getTime() : undefined) ||
      (condition.kind === 'signal'
        ? attempt.wakeKey !== condition.key
        : attempt.wakeAt?.getTime() !== new Date(condition.wakeAt).getTime())
    ) {
      return undefined;
    }
    return {
      kind: 'wait',
      result: {
        success: true,
        wait: { checkpoint: message.checkpoint, condition },
      } as WorkerTerminalResult['result'],
    };
  }

  async listWorkerLogsForRun(runId: string): Promise<WorkerLogReceipt[]> {
    const rows = await this.prisma.executionAttemptMessage.findMany({
      where: { kind: 'event', eventType: 'plugin:log', attempt: { job: { runId } } },
      include: { attempt: { include: { job: { select: { stepId: true } } } } },
      orderBy: [{ receivedAt: 'asc' }, { sequence: 'asc' }],
    });
    return rows.flatMap((row) => {
      const payload = row.payload;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
      const log = payload as Record<string, unknown>;
      if (
        !['debug', 'info', 'warn', 'error'].includes(String(log.level)) ||
        typeof log.message !== 'string' ||
        typeof log.timestamp !== 'number' ||
        !Number.isFinite(log.timestamp)
      )
        return [];
      return [
        {
          attemptId: row.attemptId,
          stepId: row.attempt.job.stepId,
          sequence: row.sequence,
          log: {
            level: log.level as WorkerLogReceipt['log']['level'],
            message: log.message.slice(0, 4_096),
            timestamp: log.timestamp,
            ...(log.stream === 'stdout' || log.stream === 'stderr' ? { stream: log.stream } : {}),
            ...(isExecutorObjectRef(log.objectRef) && log.objectRef.kind === 'log'
              ? { objectRef: log.objectRef }
              : {}),
          },
        },
      ];
    });
  }

  async timeoutExpiredWorkerAttempt(
    execution: ExecutionIdentity,
    runId: string,
    runLeaseToken: string,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const reason = JSON.stringify({
        code: 'executor_lease_expired',
        category: 'infrastructure',
        retryable: true,
        message: 'Worker lease expired during active Run',
      });
      const changed = await tx.$executeRaw`
        UPDATE "execution_attempts" AS attempt
        SET "status" = ${AttemptStatuses.TIMED_OUT},
            "finished_at" = clock_timestamp(),
            "reason" = ${reason}::jsonb,
            "lease_owner" = NULL,
            "lease_token" = NULL,
            "lease_expires_at" = NULL,
            "heartbeat_at" = NULL
        WHERE attempt."attempt_id" = ${execution.attemptId}
          AND attempt."job_id" = ${execution.jobId}
          AND attempt."attempt" = ${execution.attempt}
          AND attempt."status" IN (${AttemptStatuses.LEASED}, ${AttemptStatuses.RUNNING})
          AND attempt."lease_expires_at" < clock_timestamp()
          AND attempt."cancel_grace_until" IS NULL
          AND EXISTS (
            SELECT 1 FROM "execution_jobs" AS job
            JOIN "runs" AS run ON run."run_id" = job."run_id"
            WHERE job."job_id" = attempt."job_id"
              AND job."run_id" = ${runId}
              AND job."status" IN (${AttemptStatuses.LEASED}, ${AttemptStatuses.RUNNING})
              AND run."status" = 'running'
              AND run."is_active" = TRUE
              AND run."lease_token" = ${runLeaseToken}
              AND run."lease_expires_at" > clock_timestamp()
          )
      `;
      if (changed !== 1) return false;
      const job = await tx.executionJob.updateMany({
        where: {
          jobId: execution.jobId,
          runId,
          status: { in: [AttemptStatuses.LEASED, AttemptStatuses.RUNNING] },
        },
        data: { status: AttemptStatuses.TIMED_OUT },
      });
      if (job.count !== 1) throw new Error(`Worker timeout Job mismatch: ${execution.jobId}`);
      return true;
    });
  }

  async cancelWorkerAttempt(
    execution: ExecutionIdentity,
    runId: string,
    runLeaseToken: string,
    graceMs = 0,
  ): Promise<boolean> {
    if (!Number.isInteger(graceMs) || graceMs < 0 || graceMs > 30_000) {
      throw new Error('Invalid worker cancellation grace');
    }
    if (graceMs > 0) {
      const requested = await this.prisma.$executeRaw`
        UPDATE "execution_attempts" AS attempt
        SET "cancel_grace_until" = clock_timestamp() + (${graceMs} * INTERVAL '1 millisecond')
        WHERE attempt."attempt_id" = ${execution.attemptId}
          AND attempt."job_id" = ${execution.jobId}
          AND attempt."attempt" = ${execution.attempt}
          AND attempt."status" = ${AttemptStatuses.RUNNING}
          AND attempt."cancel_grace_until" IS NULL
          AND EXISTS (
            SELECT 1 FROM "execution_jobs" AS job
            JOIN "runs" AS run ON run."run_id" = job."run_id"
            WHERE job."job_id" = attempt."job_id"
              AND job."run_id" = ${runId}
              AND job."status" = ${AttemptStatuses.RUNNING}
              AND run."is_active" = TRUE
              AND run."lease_token" = ${runLeaseToken}
              AND run."lease_expires_at" > clock_timestamp()
          )
      `;
      if (requested === 1) return true;
      const existing = await this.prisma.executionAttempt.findUnique({
        where: { attemptId: execution.attemptId },
        select: { status: true, cancelGraceUntil: true },
      });
      if (existing?.status === AttemptStatuses.RUNNING && existing.cancelGraceUntil) return true;
    }
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.$executeRaw`
        UPDATE "execution_attempts" AS attempt
        SET "status" = ${AttemptStatuses.CANCELLED},
            "finished_at" = clock_timestamp(),
            "lease_owner" = NULL,
            "lease_token" = NULL,
            "lease_expires_at" = NULL,
            "heartbeat_at" = NULL
        WHERE attempt."attempt_id" = ${execution.attemptId}
          AND attempt."job_id" = ${execution.jobId}
          AND attempt."attempt" = ${execution.attempt}
          AND attempt."status" IN (${AttemptStatuses.QUEUED}, ${AttemptStatuses.LEASED}, ${AttemptStatuses.RUNNING})
          AND EXISTS (
            SELECT 1 FROM "execution_jobs" AS job
            JOIN "runs" AS run ON run."run_id" = job."run_id"
            WHERE job."job_id" = attempt."job_id"
              AND job."run_id" = ${runId}
              AND job."status" IN (${AttemptStatuses.QUEUED}, ${AttemptStatuses.LEASED}, ${AttemptStatuses.RUNNING})
              AND run."is_active" = TRUE
              AND run."lease_token" = ${runLeaseToken}
              AND run."lease_expires_at" > clock_timestamp()
          )
      `;
      if (changed !== 1) return false;
      const job = await tx.executionJob.updateMany({
        where: {
          jobId: execution.jobId,
          runId,
          status: {
            in: [AttemptStatuses.QUEUED, AttemptStatuses.LEASED, AttemptStatuses.RUNNING],
          },
        },
        data: { status: AttemptStatuses.CANCELLED },
      });
      if (job.count !== 1) throw new Error(`Worker cancellation Job mismatch: ${execution.jobId}`);
      return true;
    });
  }

  async fenceExpiredWorkerCancellations(): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ jobId: string }>>`
        UPDATE "execution_attempts" AS attempt
        SET "status" = ${AttemptStatuses.CANCELLED},
            "finished_at" = clock_timestamp(),
            "lease_owner" = NULL,
            "lease_token" = NULL,
            "lease_expires_at" = NULL,
            "heartbeat_at" = NULL,
            "cancel_grace_until" = NULL
        WHERE attempt."cancel_grace_until" <= clock_timestamp()
          AND attempt."status" IN (${AttemptStatuses.RUNNING}, ${AttemptStatuses.LEASED})
        RETURNING attempt."job_id" AS "jobId"
      `;
      for (const row of rows) {
        await tx.executionJob.updateMany({
          where: {
            jobId: row.jobId,
            status: { in: [AttemptStatuses.RUNNING, AttemptStatuses.LEASED] },
          },
          data: { status: AttemptStatuses.CANCELLED },
        });
      }
      return rows.length;
    });
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
          cancelGraceUntil: null,
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
        wakeReadyAt: attempt.wakeReadyAt ?? undefined,
        wakePayload: attempt.wakePayload ?? undefined,
        remoteDispatch: attempt.dispatch !== null,
      })),
    }));
  }

  async listDevelopmentAttemptsForRun(runId: string): Promise<DevelopmentAttemptView[]> {
    const rows = await this.prisma.executionAttempt.findMany({
      where: { job: { runId } },
      include: { job: { select: { stepId: true } } },
      orderBy: [{ createdAt: 'asc' }, { attempt: 'asc' }],
    });
    return rows.map((row) => ({
      attemptId: row.attemptId,
      jobId: row.jobId,
      stepId: row.job.stepId,
      attempt: row.attempt,
      status: row.status as DevelopmentAttemptView['status'],
      remote: row.dispatch !== null,
      workerId: row.leaseOwner ?? undefined,
      waitKind: row.waitKind ?? undefined,
      wakeKey: row.wakeKey ?? undefined,
      createdAt: row.createdAt,
      startedAt: row.startedAt ?? undefined,
      finishedAt: row.finishedAt ?? undefined,
      result: row.result ?? undefined,
      reason: row.reason ?? undefined,
    }));
  }

  async projectSettledWorkerAttempts(runId: string, runLeaseToken: string): Promise<number> {
    let projected = 0;
    while (true) {
      const advanced = await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        const run = await tx.run.findUnique({
          where: { runId },
          include: { events: { orderBy: { eventIndex: 'asc' } } },
        });
        if (
          !run ||
          !run.isActive ||
          run.leaseToken !== runLeaseToken ||
          !run.leaseExpiresAt ||
          run.leaseExpiresAt <= now
        ) {
          throw new Error(`Run lease unavailable for worker projection: ${runId}`);
        }
        const projectedCompletions = run.events.filter((row) => {
          const payload = row.payload as Record<string, unknown>;
          const result = payload.result as Record<string, unknown> | undefined;
          return (
            payload.type === 'step:finished' &&
            payload.workflowRunId === runId &&
            !payload.parent &&
            result?.status === 'completed'
          );
        }).length;
        if (projectedCompletions !== run.countsCompleted) {
          throw new Error(`Run event/count mismatch before worker projection: ${runId}`);
        }
        const attempts = await tx.executionAttempt.findMany({
          where: {
            job: { runId },
            status: { in: [AttemptStatuses.SUCCEEDED, AttemptStatuses.FAILED] },
            runProjectedAt: null,
          },
          include: { job: true },
          orderBy: { createdAt: 'asc' },
        });
        const attempt = attempts.find(
          (item) => item.result !== null && item.job.status === item.status,
        );
        if (!attempt) return false;
        const pluginResult = attempt.result;
        if (
          !pluginResult ||
          typeof pluginResult !== 'object' ||
          Array.isArray(pluginResult) ||
          typeof (pluginResult as Record<string, unknown>).success !== 'boolean' ||
          (pluginResult as Record<string, unknown>).success !==
            (attempt.status === AttemptStatuses.SUCCEEDED)
        ) {
          throw new Error(`Invalid settled worker result: ${attempt.attemptId}`);
        }
        const workflow = run.workflowSnapshot as unknown as WorkflowDefinition;
        const step = workflow.steps.find((item) => item.id === attempt.job.stepId);
        if (!step || step.kind === 'set_state' || step.kind === 'workflow') {
          throw new Error(`Invalid worker projection step: ${attempt.job.stepId}`);
        }
        const prior = run.events.find((row) => {
          const payload = row.payload as Record<string, unknown>;
          const result = payload.result as Record<string, unknown> | undefined;
          const execution = result?.execution as Record<string, unknown> | undefined;
          return payload.type === 'step:finished' && execution?.attemptId === attempt.attemptId;
        });
        if (prior) {
          await tx.executionAttempt.update({
            where: { attemptId: attempt.attemptId },
            data: { runProjectedAt: now },
          });
          return true;
        }
        const execution = {
          jobId: attempt.jobId,
          attemptId: attempt.attemptId,
          attempt: attempt.attempt,
        };
        const success = attempt.status === AttemptStatuses.SUCCEEDED;
        const result = success
          ? {
              stepId: step.id,
              execution,
              status: 'completed',
              success: true,
              pluginResult,
              result: (pluginResult as Record<string, unknown>).data ?? pluginResult,
            }
          : {
              stepId: step.id,
              execution,
              status: 'failed',
              success: false,
              pluginResult,
              error: {
                name: 'RemotePluginError',
                message: String(
                  (pluginResult as Record<string, unknown>).message ?? 'Remote plugin failed',
                ),
              },
              failureKind: 'plugin',
              reason: {
                code: (pluginResult as Record<string, unknown>).code ?? 'plugin',
                category: 'business',
                retryable: false,
              },
            };
        const changed = await tx.$executeRaw`
          UPDATE "runs"
          SET "counts_completed" = "counts_completed" + ${success ? 1 : 0},
              "counts_failed" = "counts_failed" + ${success ? 0 : 1},
              "updated_at" = clock_timestamp()
          WHERE "run_id" = ${runId}
            AND "lease_token" = ${runLeaseToken}
            AND "lease_expires_at" > clock_timestamp()
            AND "is_active" = TRUE
            AND "status" IN ('running', 'waiting')
            AND "counts_completed" = ${run.countsCompleted}
            AND "counts_failed" = ${run.countsFailed}
        `;
        if (changed !== 1) throw new Error(`Run lease lost during worker projection: ${runId}`);
        await tx.runEvent.create({
          data: {
            runId,
            eventIndex: (run.events[run.events.length - 1]?.eventIndex ?? -1) + 1,
            type: 'step:finished',
            payload: toInputJson({
              type: 'step:finished',
              workflowRunId: runId,
              meta: {
                workflowId: run.workflowId,
                ...(run.traceId ? { traceId: run.traceId } : {}),
              },
              step,
              execution,
              result,
            }),
          },
        });
        await tx.executionAttempt.update({
          where: { attemptId: attempt.attemptId },
          data: { runProjectedAt: now },
        });
        return true;
      });
      if (!advanced) return projected;
      projected += 1;
    }
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

  async confirmRegisteredWorkerWait(
    execution: ExecutionIdentity,
    checkpoint: ExecutionCheckpoint,
    condition: RegisterExecutionWaitInput['condition'],
  ): Promise<boolean> {
    const attempt = await this.prisma.executionAttempt.findUnique({
      where: { attemptId: execution.attemptId },
      include: {
        job: true,
        workerMessages: { orderBy: { sequence: 'desc' }, take: 1 },
      },
    });
    if (
      !attempt ||
      attempt.jobId !== execution.jobId ||
      attempt.attempt !== execution.attempt ||
      attempt.status !== AttemptStatuses.WAITING ||
      attempt.job.status !== AttemptStatuses.WAITING ||
      attempt.workerMessages[0]?.kind !== 'wait' ||
      attempt.workerMessages[0].sequence !== attempt.messageSequence
    ) {
      return false;
    }
    const saved = attempt.job.checkpoint;
    if (
      !saved ||
      typeof saved !== 'object' ||
      Array.isArray(saved) ||
      (saved as Record<string, unknown>).jobId !== execution.jobId ||
      (saved as Record<string, unknown>).sourceAttemptId !== execution.attemptId ||
      (saved as Record<string, unknown>).version !== checkpoint.version ||
      !isDeepStrictEqual((saved as Record<string, unknown>).payload, checkpoint.payload)
    ) {
      return false;
    }
    if (attempt.waitKind !== condition.kind) return false;
    if (condition.kind === 'signal' && attempt.wakeKey !== condition.key) return false;
    if (
      condition.kind === 'timer' &&
      attempt.wakeAt?.getTime() !== new Date(condition.wakeAt).getTime()
    ) {
      return false;
    }
    return (
      attempt.waitTimeoutAt?.getTime() ===
      (condition.timeoutAt ? new Date(condition.timeoutAt).getTime() : undefined)
    );
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
          job: {
            run: {
              status: 'waiting',
              OR: [{ leaseToken: null }, { leaseExpiresAt: { lt: now } }],
            },
          },
        },
        select: {
          attemptId: true,
          jobId: true,
          attempt: true,
          job: { select: { runId: true, stepId: true, idempotencyKey: true, retryPolicy: true } },
        },
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
        let canRetry = false;
        try {
          canRetry =
            Boolean(attempt.job.idempotencyKey?.trim()) &&
            attempt.attempt + 1 <
              resolveRetryPolicy(
                attempt.job.retryPolicy as { maxAttempts: number; backoffMs: number },
              ).maxAttempts;
        } catch {
          // Invalid persisted retry policy cannot authorize a new Attempt.
        }
        if (!canRetry) {
          const run = await tx.run.findUnique({
            where: { runId: attempt.job.runId },
            include: { events: { orderBy: { eventIndex: 'asc' } } },
          });
          if (!run) continue;
          const priorResults = run.events
            .map((event) => event.payload as Record<string, unknown>)
            .filter((event) => event.type === 'step:finished')
            .map((event) => event.result as Record<string, unknown>)
            .filter((result) => result?.status === 'completed' || result?.status === 'skipped');
          const workflow = run.workflowSnapshot as unknown as WorkflowDefinition;
          const step = workflow.steps.find((item) => item.id === attempt.job.stepId);
          const execution = {
            jobId: attempt.jobId,
            attemptId: attempt.attemptId,
            attempt: attempt.attempt,
          };
          const failedResult = {
            stepId: attempt.job.stepId,
            execution,
            status: 'failed',
            success: false,
            error: { name: 'ExecutionWaitTimeoutError', message: 'Execution wait timed out' },
            failureKind: 'resource',
            reason: {
              code: 'wait_timeout',
              category: 'infrastructure',
              retryable: false,
              message: 'Execution wait timed out; no retry is available',
            },
          };
          const result = {
            success: false,
            status: 'failed',
            workflowId: run.workflowId,
            results: [...priorResults, failedResult],
            terminalReason: 'step_failed',
          };
          const settled = await tx.run.updateMany({
            where: {
              runId: attempt.job.runId,
              status: 'waiting',
              isActive: true,
              OR: [{ leaseToken: null }, { leaseExpiresAt: { lt: now } }],
            },
            data: {
              status: 'failed',
              isActive: false,
              countsFailed: { increment: 1 },
              finishedAt: now,
              result: toInputJson(result),
            },
          });
          if (settled.count === 1) {
            const nextOffset = (run.events[run.events.length - 1]?.eventIndex ?? -1) + 1;
            await tx.runEvent.create({
              data: {
                runId: run.runId,
                eventIndex: nextOffset,
                type: 'step:finished',
                payload: toInputJson({
                  type: 'step:finished',
                  workflowRunId: run.runId,
                  step: step ?? { id: attempt.job.stepId },
                  execution,
                  result: failedResult,
                }),
              },
            });
            await tx.runEvent.create({
              data: {
                runId: run.runId,
                eventIndex: nextOffset + 1,
                type: 'workflow:finished',
                payload: toInputJson({
                  type: 'workflow:finished',
                  workflowRunId: run.runId,
                  result,
                }),
              },
            });
          }
        }
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

  async cancelWaitingRun(
    runId: string,
    mode: 'best-effort' | 'hard',
    status: 'waiting' | 'paused' = 'waiting',
  ): Promise<boolean> {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.run.updateMany({
        where: {
          runId,
          status,
          isActive: true,
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
        },
        data: { status: 'cancelled', isActive: false, cancelled: mode, finishedAt: now },
      });
      if (changed.count !== 1) return false;
      await tx.executionAttempt.updateMany({
        where: {
          job: { runId },
          status: {
            in: [
              AttemptStatuses.QUEUED,
              AttemptStatuses.LEASED,
              AttemptStatuses.RUNNING,
              AttemptStatuses.WAITING,
            ],
          },
        },
        data: {
          status: AttemptStatuses.CANCELLED,
          finishedAt: now,
          reason: toInputJson({ code: 'user_cancelled', category: 'cancelled', retryable: false }),
        },
      });
      await tx.executionJob.updateMany({
        where: {
          runId,
          status: {
            in: [
              AttemptStatuses.QUEUED,
              AttemptStatuses.LEASED,
              AttemptStatuses.RUNNING,
              AttemptStatuses.WAITING,
            ],
          },
        },
        data: { status: AttemptStatuses.CANCELLED },
      });
      return true;
    });
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
