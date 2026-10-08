import { randomUUID } from 'node:crypto';
import {
  AttemptStatuses,
  EXECUTOR_PROTOCOL_VERSION,
  type ExecutorDispatchV1,
} from '@monai-devops/core-engine';
import { assertTestDatabaseUrl } from '../common/storage/assert-test-database-url.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PrismaExecutionRepository } from './prisma-execution.repository.js';

const describeIfDb = process.env.DATABASE_URL?.trim() ? describe : describe.skip;

describeIfDb('PrismaExecutionRepository worker transport', () => {
  const prisma = new PrismaService();
  const repository = new PrismaExecutionRepository(prisma);
  let request: ExecutorDispatchV1;
  const offers = [{ name: 'test-plugin', version: '1.0.0', capabilities: ['execution.wait'] }];

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
      workflowId: 'worker-transport-test',
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
        workflowName: 'Worker transport test',
        status: 'running',
        leaseOwner: 'server-1',
        leaseToken: 'run-token',
        leaseExpiresAt: new Date(Date.now() + 60_000),
        workflowSnapshot: { id: request.workflowId, name: 'Test', steps: [] },
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
    await prisma.run.delete({ where: { runId: request.runId } });
  });

  it('claims only registered dispatches once and preserves the sequence for messages', async () => {
    expect(await repository.claimWorkerDispatch('worker-1', 30_000, offers)).toBeUndefined();
    expect(await repository.registerWorkerDispatch(request, 'run-token')).toBe(true);
    const [first, second] = await Promise.all([
      repository.claimWorkerDispatch('worker-1', 30_000, offers),
      repository.claimWorkerDispatch('worker-2', 30_000, offers),
    ]);
    const claimed = first ?? second;
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(claimed?.dispatch).toEqual(request);
    expect(claimed?.claim.nextSequence).toBe(1);
    expect(claimed?.claim.workerId).toMatch(/^worker-[12]$/);
    const message = {
      protocolVersion: EXECUTOR_PROTOCOL_VERSION,
      execution: request.execution,
      leaseToken: claimed!.claim.leaseToken,
      sequence: claimed!.claim.nextSequence,
      occurredAt: new Date().toISOString(),
      kind: 'complete' as const,
      result: { success: true, data: { value: 1 } },
    };
    expect((await repository.acceptRegisteredWorkerMessage(message, 30_000)).accepted).toBe(true);
    expect(await repository.acceptRegisteredWorkerMessage(message, 30_000)).toEqual({
      accepted: false,
      code: 'duplicate',
    });
    expect(
      (
        await prisma.executionAttempt.findUniqueOrThrow({
          where: { attemptId: request.execution.attemptId },
        })
      ).status,
    ).toBe(AttemptStatuses.SUCCEEDED);
  });

  it('does not claim a dispatch after its Run lease expires', async () => {
    expect(await repository.registerWorkerDispatch(request, 'run-token')).toBe(true);
    await prisma.run.update({
      where: { runId: request.runId },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    expect(await repository.claimWorkerDispatch('worker-1', 30_000, offers)).toBeUndefined();
    expect(await repository.acceptRegisteredWorkerMessage({}, 30_000)).toEqual({
      accepted: false,
      code: 'invalid_identity',
    });
  });

  it('fences a message from another authenticated worker even with the lease token', async () => {
    expect(await repository.registerWorkerDispatch(request, 'run-token')).toBe(true);
    const claimed = await repository.claimWorkerDispatch('worker-1', 30_000, offers);
    expect(claimed).toBeDefined();
    const message = {
      protocolVersion: EXECUTOR_PROTOCOL_VERSION,
      execution: request.execution,
      leaseToken: claimed!.claim.leaseToken,
      sequence: 1,
      occurredAt: new Date().toISOString(),
      kind: 'complete' as const,
      result: { success: true },
    };
    expect(await repository.acceptRegisteredWorkerMessage(message, 30_000, 'worker-2')).toEqual({
      accepted: false,
      code: 'invalid_identity',
    });
    expect(
      (await repository.acceptRegisteredWorkerMessage(message, 30_000, 'worker-1')).accepted,
    ).toBe(true);
    expect(await repository.acceptRegisteredWorkerMessage(message, 30_000, 'worker-1')).toEqual({
      accepted: false,
      code: 'duplicate',
    });
    expect(await repository.acceptRegisteredWorkerMessage(message, 30_000, 'worker-2')).toEqual({
      accepted: false,
      code: 'invalid_identity',
    });
  });

  it('leaves work queued for a worker offering the matching plugin version and capabilities', async () => {
    request = { ...request, requiredCapabilities: ['execution.wait'] };
    expect(await repository.registerWorkerDispatch(request, 'run-token')).toBe(true);
    expect(
      await repository.claimWorkerDispatch('wrong-version', 30_000, [
        { name: 'test-plugin', version: '2.0.0', capabilities: ['execution.wait'] },
      ]),
    ).toBeUndefined();
    expect(
      await repository.claimWorkerDispatch('missing-capability', 30_000, [
        { name: 'test-plugin', version: '1.0.0', capabilities: [] },
      ]),
    ).toBeUndefined();
    expect(
      (
        await prisma.executionAttempt.findUniqueOrThrow({
          where: { attemptId: request.execution.attemptId },
        })
      ).status,
    ).toBe(AttemptStatuses.QUEUED);
    expect(
      (await repository.claimWorkerDispatch('qualified', 30_000, offers))?.claim.workerId,
    ).toBe('qualified');
  });
});
