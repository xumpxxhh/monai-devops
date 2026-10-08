import { randomUUID } from 'node:crypto';
import { AttemptStatuses } from '@monai-devops/core-engine';
import { assertTestDatabaseUrl } from '../common/storage/assert-test-database-url.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PrismaExecutionRepository } from './prisma-execution.repository.js';

const describeIfDb = process.env.DATABASE_URL?.trim() ? describe : describe.skip;

describeIfDb('PrismaExecutionRepository token-fenced leases', () => {
  const prisma = new PrismaService();
  const repository = new PrismaExecutionRepository(prisma);
  let runId: string;
  let attemptId: string;

  beforeAll(async () => {
    assertTestDatabaseUrl();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    runId = randomUUID();
    const execution = { jobId: `${runId}/step`, attemptId: `${runId}/step/attempt-0`, attempt: 0 };
    attemptId = execution.attemptId;
    await prisma.run.create({
      data: {
        runId,
        workflowId: 'lease-test',
        workflowName: 'Lease test',
        status: 'running',
        workflowSnapshot: { id: 'lease-test', name: 'Lease test', steps: [] },
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
  });

  afterEach(async () => {
    await prisma.run.delete({ where: { runId } });
  });

  it('rejects wrong-token start and renewal, then starts under the current token', async () => {
    expect(
      await repository.acquireLease(
        attemptId,
        'worker-1',
        'token-1',
        new Date(Date.now() + 60_000),
      ),
    ).toBe(true);
    expect(await repository.startLeasedAttempt(attemptId, 'wrong-token')).toBe(false);
    expect(
      await repository.heartbeat(attemptId, 'wrong-token', new Date(Date.now() + 60_000)),
    ).toBe(false);
    expect(await repository.startLeasedAttempt(attemptId, 'token-1')).toBe(true);
    expect(await repository.startLeasedAttempt(attemptId, 'token-1')).toBe(false);
    expect(await repository.heartbeat(attemptId, 'token-1', new Date(Date.now() + 60_000))).toBe(
      true,
    );
    expect((await prisma.executionAttempt.findUnique({ where: { attemptId } }))?.status).toBe(
      AttemptStatuses.RUNNING,
    );
  });

  it('does not revive an expired lease or let its former token act after takeover', async () => {
    expect(
      await repository.acquireLease(
        attemptId,
        'worker-1',
        'token-1',
        new Date(Date.now() + 60_000),
      ),
    ).toBe(true);
    await prisma.executionAttempt.update({
      where: { attemptId },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    expect(await repository.startLeasedAttempt(attemptId, 'token-1')).toBe(false);
    expect(await repository.heartbeat(attemptId, 'token-1', new Date(Date.now() + 60_000))).toBe(
      false,
    );
    expect(
      await repository.acquireLease(
        attemptId,
        'worker-2',
        'token-2',
        new Date(Date.now() + 60_000),
      ),
    ).toBe(true);
    expect(await repository.startLeasedAttempt(attemptId, 'token-1')).toBe(false);
    expect(await repository.heartbeat(attemptId, 'token-1', new Date(Date.now() + 60_000))).toBe(
      false,
    );
    expect(await repository.startLeasedAttempt(attemptId, 'token-2')).toBe(true);
    expect((await prisma.executionAttempt.findUnique({ where: { attemptId } }))?.leaseOwner).toBe(
      'worker-2',
    );
  });

  it('settles an expired worker Attempt/Job only under the live Run lease', async () => {
    const execution = { jobId: `${runId}/step`, attemptId, attempt: 0 };
    await prisma.run.update({
      where: { runId },
      data: {
        leaseOwner: 'server-1',
        leaseToken: 'run-token',
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    expect(
      await repository.acquireLease(
        attemptId,
        'worker-1',
        'worker-token',
        new Date(Date.now() + 60_000),
      ),
    ).toBe(true);
    expect(await repository.startLeasedAttempt(attemptId, 'worker-token')).toBe(true);
    await repository.setJobStatus(execution.jobId, AttemptStatuses.RUNNING);
    expect(await repository.timeoutExpiredWorkerAttempt(execution, runId, 'run-token')).toBe(false);
    await prisma.executionAttempt.update({
      where: { attemptId },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    expect(await repository.timeoutExpiredWorkerAttempt(execution, runId, 'wrong-token')).toBe(
      false,
    );
    expect((await prisma.executionAttempt.findUniqueOrThrow({ where: { attemptId } })).status).toBe(
      AttemptStatuses.RUNNING,
    );
    expect(await repository.timeoutExpiredWorkerAttempt(execution, runId, 'run-token')).toBe(true);
    expect(await repository.timeoutExpiredWorkerAttempt(execution, runId, 'run-token')).toBe(false);
    expect(
      await repository.heartbeat(attemptId, 'worker-token', new Date(Date.now() + 60_000)),
    ).toBe(false);
    expect(
      await repository.acquireLease(
        attemptId,
        'worker-2',
        'next-token',
        new Date(Date.now() + 60_000),
      ),
    ).toBe(false);
    expect(await prisma.executionAttempt.findUniqueOrThrow({ where: { attemptId } })).toMatchObject(
      {
        status: AttemptStatuses.TIMED_OUT,
        leaseOwner: null,
        leaseToken: null,
        reason: { code: 'executor_lease_expired', retryable: true },
      },
    );
    expect(
      (await prisma.executionJob.findUniqueOrThrow({ where: { jobId: execution.jobId } })).status,
    ).toBe(AttemptStatuses.TIMED_OUT);
  });

  it('does not settle an expired worker after the Run owner loses its lease', async () => {
    const execution = { jobId: `${runId}/step`, attemptId, attempt: 0 };
    await prisma.run.update({
      where: { runId },
      data: { leaseToken: 'run-token', leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    expect(
      await repository.acquireLease(
        attemptId,
        'worker-1',
        'worker-token',
        new Date(Date.now() + 60_000),
      ),
    ).toBe(true);
    expect(await repository.startLeasedAttempt(attemptId, 'worker-token')).toBe(true);
    await repository.setJobStatus(execution.jobId, AttemptStatuses.RUNNING);
    await prisma.executionAttempt.update({
      where: { attemptId },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    expect(await repository.timeoutExpiredWorkerAttempt(execution, runId, 'run-token')).toBe(false);
    expect((await prisma.executionAttempt.findUniqueOrThrow({ where: { attemptId } })).status).toBe(
      AttemptStatuses.RUNNING,
    );
  });

  it('preserves a pending cancellation across Run lease loss until the cancellation sweeper fences it', async () => {
    const execution = { jobId: `${runId}/step`, attemptId, attempt: 0 };
    await prisma.run.update({
      where: { runId },
      data: { leaseToken: 'run-token', leaseExpiresAt: new Date(Date.now() + 60_000) },
    });
    expect(
      await repository.acquireLease(
        attemptId,
        'worker-1',
        'worker-token',
        new Date(Date.now() + 60_000),
      ),
    ).toBe(true);
    expect(await repository.startLeasedAttempt(attemptId, 'worker-token')).toBe(true);
    await repository.setJobStatus(execution.jobId, AttemptStatuses.RUNNING);
    expect(await repository.cancelWorkerAttempt(execution, runId, 'run-token', 5_000)).toBe(true);
    await prisma.run.update({
      where: { runId },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    await prisma.executionAttempt.update({
      where: { attemptId },
      data: {
        leaseExpiresAt: new Date(Date.now() - 1_000),
        cancelGraceUntil: new Date(Date.now() - 1_000),
      },
    });
    expect(
      await repository.timeoutExpiredAttempt(attemptId, new Date(), { code: 'lease_expired' }),
    ).toBe(false);
    expect(await repository.fenceExpiredWorkerCancellations()).toBe(1);
    expect((await prisma.executionAttempt.findUniqueOrThrow({ where: { attemptId } })).status).toBe(
      AttemptStatuses.CANCELLED,
    );
  });
});
