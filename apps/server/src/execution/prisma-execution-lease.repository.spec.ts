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
});
