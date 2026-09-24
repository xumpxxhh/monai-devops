import { randomUUID } from 'node:crypto';
import { AttemptStatuses } from '@monai-devops/core-engine';
import { assertTestDatabaseUrl } from '../common/storage/assert-test-database-url.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PrismaExecutionRepository } from './prisma-execution.repository.js';

const describeIfDb = process.env.DATABASE_URL?.trim() ? describe : describe.skip;

describeIfDb('PrismaExecutionRepository durable waits', () => {
  const prisma = new PrismaService();
  const repository = new PrismaExecutionRepository(prisma);
  let runId: string;
  let execution: { jobId: string; attemptId: string; attempt: number };

  beforeAll(async () => {
    assertTestDatabaseUrl();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    runId = randomUUID();
    execution = { jobId: `${runId}/step`, attemptId: `${runId}/step/attempt-0`, attempt: 0 };
    await prisma.run.create({
      data: {
        runId,
        workflowId: 'wait-test',
        workflowName: 'Wait test',
        status: 'running',
        workflowSnapshot: { id: 'wait-test', name: 'Wait test', steps: [] },
      },
    });
    await repository.ensureJob({
      execution,
      runId,
      stepId: 'step',
      idempotencyKey: execution.jobId,
      retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    });
    await repository.ensureAttempt(execution);
    expect(
      await repository.acquireLease(
        execution.attemptId,
        'owner-1',
        'token-1',
        new Date(Date.now() + 60_000),
      ),
    ).toBe(true);
    expect(
      await repository.transitionAttempt(
        execution.attemptId,
        AttemptStatuses.LEASED,
        AttemptStatuses.RUNNING,
      ),
    ).toBe(true);
  });

  afterEach(async () => {
    await prisma.run.delete({ where: { runId } });
  });

  it('loads the persisted Job, Attempt and checkpoint for Run reconstruction', async () => {
    const checkpoint = {
      jobId: execution.jobId,
      sourceAttemptId: execution.attemptId,
      version: 1,
      payload: { cursor: 'page-2' },
      createdAt: new Date().toISOString(),
    };
    await repository.saveCheckpoint(checkpoint);

    expect(await repository.listJobsForRun(runId)).toEqual([
      expect.objectContaining({
        stepId: 'step',
        checkpoint,
        attempts: [expect.objectContaining({ attempt: 0, status: AttemptStatuses.RUNNING })],
      }),
    ]);
  });

  it('does not time out an Attempt that renewed after a stale recovery scan', async () => {
    const now = new Date();
    await prisma.executionAttempt.update({
      where: { attemptId: execution.attemptId },
      data: { leaseExpiresAt: new Date(now.getTime() - 1_000) },
    });
    expect((await repository.listRecoverable(now)).map((item) => item.attemptId)).toContain(
      execution.attemptId,
    );
    expect(
      await repository.heartbeat(execution.attemptId, 'token-1', new Date(now.getTime() + 60_000)),
    ).toBe(true);
    expect(
      await repository.timeoutExpiredAttempt(execution.attemptId, now, {
        code: 'executor_lease_expired',
      }),
    ).toBe(false);
    expect(
      (
        await prisma.executionAttempt.findUniqueOrThrow({
          where: { attemptId: execution.attemptId },
        })
      ).status,
    ).toBe(AttemptStatuses.RUNNING);

    await prisma.executionAttempt.update({
      where: { attemptId: execution.attemptId },
      data: { leaseExpiresAt: new Date(now.getTime() - 1_000) },
    });
    await prisma.run.update({
      where: { runId },
      data: { leaseExpiresAt: new Date(now.getTime() + 60_000) },
    });
    expect(
      await repository.timeoutExpiredAttempt(execution.attemptId, now, {
        code: 'executor_lease_expired',
      }),
    ).toBe(false);
    await prisma.run.update({
      where: { runId },
      data: { leaseExpiresAt: new Date(now.getTime() - 1_000) },
    });
    expect(
      await repository.timeoutExpiredAttempt(execution.attemptId, now, {
        code: 'executor_lease_expired',
      }),
    ).toBe(true);
    expect(
      (await prisma.executionJob.findUniqueOrThrow({ where: { jobId: execution.jobId } })).status,
    ).toBe(AttemptStatuses.TIMED_OUT);
  });

  it('atomically saves checkpoint and requires a matching signal before re-leasing', async () => {
    const checkpoint = {
      jobId: execution.jobId,
      sourceAttemptId: execution.attemptId,
      version: 1,
      payload: { cursor: 'page-2' },
      createdAt: new Date().toISOString(),
    };
    const input = {
      execution,
      checkpoint,
      leaseToken: 'token-1',
      condition: {
        kind: 'signal' as const,
        key: 'approval',
        timeoutAt: new Date(Date.now() + 60_000).toISOString(),
      },
    };

    expect(await repository.registerWait({ ...input, leaseToken: 'wrong' })).toBe(false);
    expect(await repository.registerWait(input)).toBe(true);
    expect(await repository.registerWait(input)).toBe(false);

    const attempt = await prisma.executionAttempt.findUniqueOrThrow({
      where: { attemptId: execution.attemptId },
    });
    const job = await prisma.executionJob.findUniqueOrThrow({ where: { jobId: execution.jobId } });
    expect(attempt.status).toBe(AttemptStatuses.WAITING);
    expect(attempt.leaseToken).toBeNull();
    expect(job.checkpoint).toEqual(checkpoint);
    expect(job.status).toBe(AttemptStatuses.WAITING);
    expect(
      await repository.acquireLease(
        execution.attemptId,
        'owner-2',
        'token-2',
        new Date(Date.now() + 60_000),
      ),
    ).toBe(false);
    expect(await repository.signalWait(execution.attemptId, 'wrong', {}, new Date())).toBe(false);
    expect(
      await repository.signalWait(execution.attemptId, 'approval', { accepted: true }, new Date()),
    ).toBe(true);
    expect(
      await repository.signalWait(execution.attemptId, 'approval', { accepted: true }, new Date()),
    ).toBe(false);
    expect(
      await repository.acquireLease(
        execution.attemptId,
        'owner-2',
        'token-2',
        new Date(Date.now() + 60_000),
      ),
    ).toBe(true);
  });

  it('wakes due timers and expires waits that hit their deadline', async () => {
    const checkpoint = {
      jobId: execution.jobId,
      sourceAttemptId: execution.attemptId,
      version: 1,
      payload: {},
      createdAt: new Date().toISOString(),
    };
    const now = new Date();
    expect(
      await repository.registerWait({
        execution,
        leaseToken: 'token-1',
        checkpoint,
        condition: { kind: 'timer', wakeAt: new Date(now.getTime() + 5_000).toISOString() },
      }),
    ).toBe(true);
    expect(await repository.wakeDueTimers(now)).toBe(0);
    expect(await repository.wakeDueTimers(new Date(now.getTime() + 6_000))).toBe(1);
    expect(await repository.wakeDueTimers(new Date(now.getTime() + 6_000))).toBe(0);
    expect(
      await repository.acquireLease(
        execution.attemptId,
        'owner-2',
        'token-2',
        new Date(Date.now() + 60_000),
      ),
    ).toBe(true);
  });

  it('marks an expired signal wait terminal and prevents late signals', async () => {
    const now = new Date();
    expect(
      await repository.registerWait({
        execution,
        leaseToken: 'token-1',
        checkpoint: {
          jobId: execution.jobId,
          sourceAttemptId: execution.attemptId,
          version: 1,
          payload: {},
          createdAt: now.toISOString(),
        },
        condition: {
          kind: 'signal',
          key: 'approval',
          timeoutAt: new Date(now.getTime() + 5_000).toISOString(),
        },
      }),
    ).toBe(true);
    expect(await repository.expireWaits(new Date(now.getTime() + 6_000))).toBe(1);
    expect(
      await repository.signalWait(
        execution.attemptId,
        'approval',
        {},
        new Date(now.getTime() + 7_000),
      ),
    ).toBe(false);
    const attempt = await prisma.executionAttempt.findUniqueOrThrow({
      where: { attemptId: execution.attemptId },
    });
    expect(attempt.status).toBe(AttemptStatuses.TIMED_OUT);
    expect(
      await repository.acquireLease(
        execution.attemptId,
        'owner-2',
        'token-2',
        new Date(Date.now() + 60_000),
      ),
    ).toBe(false);
  });
});
