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

  it('stores a large result behind an Attempt-bound reference with owner-only reads and expiry', async () => {
    expect(await repository.registerWorkerDispatch(request, 'run-token')).toBe(true);
    const claimed = await repository.claimWorkerDispatch('worker-1', 30_000, offers);
    expect(claimed).toBeDefined();
    const content = Buffer.from(JSON.stringify({ success: true, data: 'x'.repeat(70_000) }));
    const ref = await repository.storeWorkerObject(
      'worker-1',
      request.execution,
      claimed!.claim.leaseToken,
      'result',
      content,
    );
    expect(ref).toMatchObject({ version: 1, kind: 'result', sizeBytes: content.length });
    expect(await repository.readWorkerObject('worker-2', ref!.objectId)).toBeUndefined();
    expect((await repository.readWorkerObject('worker-1', ref!.objectId))?.content).toEqual(
      content,
    );
    const message = {
      protocolVersion: EXECUTOR_PROTOCOL_VERSION,
      execution: request.execution,
      leaseToken: claimed!.claim.leaseToken,
      sequence: 1,
      occurredAt: new Date().toISOString(),
      kind: 'complete' as const,
      result: { success: true, data: { objectRef: ref } },
    };
    expect(
      (await repository.acceptRegisteredWorkerMessage(message, 30_000, 'worker-1')).accepted,
    ).toBe(true);
    expect((await repository.readWorkerTerminal(request.execution))?.result.data).toEqual({
      objectRef: ref,
    });
    expect(await prisma.runEvent.count({ where: { runId: request.runId } })).toBe(0);
    expect(
      await repository.cleanupExpiredWorkerObjects(new Date(Date.now() + 8 * 24 * 60 * 60_000)),
    ).toBeGreaterThanOrEqual(1);
    expect(await repository.readWorkerObject('worker-1', ref!.objectId)).toBeUndefined();
  });

  it('rejects a forged or cross-Attempt result reference before settlement', async () => {
    expect(await repository.registerWorkerDispatch(request, 'run-token')).toBe(true);
    const claimed = await repository.claimWorkerDispatch('worker-1', 30_000, offers);
    const forged = {
      version: 1,
      objectId: randomUUID(),
      kind: 'result',
      contentType: 'application/json',
      sizeBytes: 70_000,
      sha256: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const message = {
      protocolVersion: EXECUTOR_PROTOCOL_VERSION,
      execution: request.execution,
      leaseToken: claimed!.claim.leaseToken,
      sequence: 1,
      occurredAt: new Date().toISOString(),
      kind: 'complete' as const,
      result: { success: true, data: { objectRef: forged } },
    };
    expect(await repository.acceptRegisteredWorkerMessage(message, 30_000, 'worker-1')).toEqual({
      accepted: false,
      code: 'invalid_payload',
    });
    expect(
      (
        await prisma.executionAttempt.findUniqueOrThrow({
          where: { attemptId: request.execution.attemptId },
        })
      ).status,
    ).toBe(AttemptStatuses.RUNNING);
  });

  it('persists oversized logs only as authorized object references', async () => {
    expect(await repository.registerWorkerDispatch(request, 'run-token')).toBe(true);
    const claimed = await repository.claimWorkerDispatch('worker-1', 30_000, offers);
    const content = Buffer.from('x'.repeat(5_000));
    const ref = await repository.storeWorkerObject(
      'worker-1',
      request.execution,
      claimed!.claim.leaseToken,
      'log',
      content,
    );
    expect(ref?.kind).toBe('log');
    const message = {
      protocolVersion: EXECUTOR_PROTOCOL_VERSION,
      execution: request.execution,
      leaseToken: claimed!.claim.leaseToken,
      sequence: 1,
      occurredAt: new Date().toISOString(),
      kind: 'event' as const,
      eventType: 'plugin:log',
      payloadVersion: 1,
      payload: {
        level: 'info',
        message: '[log stored as object]',
        timestamp: Date.now(),
        objectRef: ref,
      },
    };
    expect(
      (await repository.acceptRegisteredWorkerMessage(message, 30_000, 'worker-1')).accepted,
    ).toBe(true);
    expect((await repository.listWorkerLogsForRun(request.runId))[0]?.log.objectRef).toEqual(ref);
    expect(
      JSON.stringify(
        await prisma.executionAttemptMessage.findMany({
          where: { attemptId: request.execution.attemptId },
        }),
      ),
    ).not.toContain('x'.repeat(100));
  });
});
