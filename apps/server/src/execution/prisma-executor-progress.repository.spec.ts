import { randomUUID } from 'node:crypto';
import {
  EXECUTOR_PROTOCOL_VERSION,
  type ExecutorDispatchV1,
  type ExecutorMessageV1,
} from '@monai-devops/core-engine';
import { assertTestDatabaseUrl } from '../common/storage/assert-test-database-url.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PrismaExecutionRepository } from './prisma-execution.repository.js';

const describeIfDb = process.env.DATABASE_URL?.trim() ? describe : describe.skip;

describeIfDb('PrismaExecutionRepository worker progress inbox', () => {
  const prisma = new PrismaService();
  const repository = new PrismaExecutionRepository(prisma);
  let request: ExecutorDispatchV1;

  beforeAll(async () => {
    assertTestDatabaseUrl();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    const runId = randomUUID();
    const execution = { jobId: `${runId}/step`, attemptId: `${runId}/step/attempt-0`, attempt: 0 };
    request = {
      protocolVersion: EXECUTOR_PROTOCOL_VERSION,
      runId,
      workflowId: 'worker-inbox-test',
      stepId: 'step',
      execution,
      plugin: { name: 'test-plugin', version: '1.0.0' },
      idempotencyKey: execution.jobId,
      policyVersion: 'test-policy',
      requiredCapabilities: [],
      input: { config: {}, context: {} },
    };
    await prisma.run.create({
      data: {
        runId,
        workflowId: request.workflowId,
        workflowName: 'Worker inbox test',
        status: 'running',
        workflowSnapshot: { id: request.workflowId, name: 'Worker inbox test', steps: [] },
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
        'worker-1',
        'token-1',
        new Date(Date.now() + 60_000),
      ),
    ).toBe(true);
    expect(await repository.startLeasedAttempt(execution.attemptId, 'token-1')).toBe(true);
  });

  afterEach(async () => {
    await prisma.run.delete({ where: { runId: request.runId } });
  });

  function progress(kind: 'heartbeat' | 'event', sequence: number): ExecutorMessageV1 {
    const base = {
      protocolVersion: EXECUTOR_PROTOCOL_VERSION,
      execution: request.execution,
      leaseToken: 'token-1',
      sequence,
      occurredAt: new Date().toISOString(),
    };
    return kind === 'event'
      ? { ...base, kind, eventType: 'plugin:log', payloadVersion: 1, payload: { line: 'ok' } }
      : { ...base, kind };
  }

  it('persists ordered heartbeat and event once without projecting into RunEvent', async () => {
    const heartbeat = await repository.acceptWorkerProgress(
      request,
      progress('heartbeat', 1),
      30_000,
    );
    expect(heartbeat.accepted).toBe(true);
    const event = await repository.acceptWorkerProgress(request, progress('event', 2), 30_000);
    expect(event.accepted).toBe(true);
    expect(
      await prisma.executionAttempt.findUnique({
        where: { attemptId: request.execution.attemptId },
      }),
    ).toMatchObject({ messageSequence: 2 });
    expect(
      await prisma.executionAttemptMessage.findMany({
        where: { attemptId: request.execution.attemptId },
        orderBy: { sequence: 'asc' },
      }),
    ).toMatchObject([
      { sequence: 1, kind: 'heartbeat' },
      { sequence: 2, kind: 'event', eventType: 'plugin:log', payload: { line: 'ok' } },
    ]);
    expect(await prisma.runEvent.count({ where: { runId: request.runId } })).toBe(0);
    expect(await repository.acceptWorkerProgress(request, progress('event', 2), 30_000)).toEqual({
      accepted: false,
      code: 'duplicate',
    });
  });

  it('rejects gaps, wrong tokens and expired leases without writing a message', async () => {
    expect(await repository.acceptWorkerProgress(request, progress('event', 2), 30_000)).toEqual({
      accepted: false,
      code: 'out_of_order',
    });
    expect(
      await repository.acceptWorkerProgress(
        request,
        { ...progress('event', 1), leaseToken: 'wrong' },
        30_000,
      ),
    ).toEqual({ accepted: false, code: 'stale_lease' });
    await prisma.executionAttempt.update({
      where: { attemptId: request.execution.attemptId },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    expect(await repository.acceptWorkerProgress(request, progress('event', 1), 30_000)).toEqual({
      accepted: false,
      code: 'expired_lease',
    });
    expect(
      await prisma.executionAttemptMessage.count({
        where: { attemptId: request.execution.attemptId },
      }),
    ).toBe(0);
  });

  it('lets only one concurrent sender claim the same sequence', async () => {
    const results = await Promise.all([
      repository.acceptWorkerProgress(request, progress('event', 1), 30_000),
      repository.acceptWorkerProgress(request, progress('event', 1), 30_000),
    ]);
    expect(results.filter((result) => result.accepted)).toHaveLength(1);
    expect(results.filter((result) => !result.accepted)).toEqual([
      { accepted: false, code: 'duplicate' },
    ]);
    expect(
      await prisma.executionAttemptMessage.count({
        where: { attemptId: request.execution.attemptId },
      }),
    ).toBe(1);
  });

  it('continues the sequence after takeover while fencing the previous token', async () => {
    expect(
      (await repository.acceptWorkerProgress(request, progress('event', 1), 30_000)).accepted,
    ).toBe(true);
    await prisma.executionAttempt.update({
      where: { attemptId: request.execution.attemptId },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    expect(
      await repository.acquireLease(
        request.execution.attemptId,
        'worker-2',
        'token-2',
        new Date(Date.now() + 60_000),
      ),
    ).toBe(true);
    expect(await repository.startLeasedAttempt(request.execution.attemptId, 'token-2')).toBe(true);
    expect(await repository.acceptWorkerProgress(request, progress('event', 2), 30_000)).toEqual({
      accepted: false,
      code: 'stale_lease',
    });
    expect(
      (
        await repository.acceptWorkerProgress(
          request,
          { ...progress('event', 2), leaseToken: 'token-2' },
          30_000,
        )
      ).accepted,
    ).toBe(true);
  });

  it('does not accept terminal messages through the progress-only inbox', async () => {
    expect(
      await repository.acceptWorkerProgress(
        request,
        {
          ...progress('heartbeat', 1),
          kind: 'complete',
          result: { success: true },
        },
        30_000,
      ),
    ).toEqual({ accepted: false, code: 'invalid_payload' });
    expect(
      await prisma.executionAttemptMessage.count({
        where: { attemptId: request.execution.attemptId },
      }),
    ).toBe(0);
  });
});
