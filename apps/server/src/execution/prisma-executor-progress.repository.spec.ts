import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  AttemptStatuses,
  EXECUTOR_PROTOCOL_VERSION,
  createWorkflowExecutor,
  type ExecutorDispatchV1,
  type ExecutorMessageV1,
} from '@monai-devops/core-engine';
import { assertTestDatabaseUrl } from '../common/storage/assert-test-database-url.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { toRunRecord } from '../runs/run-record.mapper.js';
import { buildRunRecoverySnapshot } from '../runs/run-recovery-snapshot.js';
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
      requiredCapabilities: ['execution.wait'],
      input: { config: {}, context: {} },
    };
    await prisma.run.create({
      data: {
        runId,
        workflowId: request.workflowId,
        workflowName: 'Worker inbox test',
        status: 'running',
        leaseOwner: 'server-1',
        leaseToken: 'run-token',
        leaseExpiresAt: new Date(Date.now() + 60_000),
        countsTotal: 1,
        workflowSnapshot: {
          id: request.workflowId,
          name: 'Worker inbox test',
          steps: [{ id: 'step', name: 'Step', plugin: 'test-plugin', config: {} }],
        },
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
    expect(await repository.registerWorkerDispatch(request, 'wrong-run-token')).toBe(false);
    expect(await repository.registerWorkerDispatch(request, 'run-token')).toBe(true);
    expect(await repository.registerWorkerDispatch(request, 'run-token')).toBe(false);
    expect(
      await repository.acquireLease(
        execution.attemptId,
        'worker-1',
        'token-1',
        new Date(Date.now() + 60_000),
      ),
    ).toBe(true);
    expect(await repository.startLeasedAttempt(execution.attemptId, 'token-1')).toBe(true);
    await repository.setJobStatus(execution.jobId, AttemptStatuses.RUNNING);
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
      ? {
          ...base,
          kind,
          eventType: 'plugin:log',
          payloadVersion: 1,
          payload: { level: 'info', message: 'ok', timestamp: Date.now() },
        }
      : { ...base, kind };
  }

  it('persists ordered heartbeat and event once without projecting into RunEvent', async () => {
    const heartbeat = await repository.acceptWorkerMessage(
      request,
      progress('heartbeat', 1),
      30_000,
    );
    expect(heartbeat.accepted).toBe(true);
    const event = await repository.acceptWorkerMessage(request, progress('event', 2), 30_000);
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
      {
        sequence: 2,
        kind: 'event',
        eventType: 'plugin:log',
        payload: { level: 'info', message: 'ok' },
      },
    ]);
    expect(await prisma.runEvent.count({ where: { runId: request.runId } })).toBe(0);
    expect(await repository.acceptWorkerMessage(request, progress('event', 2), 30_000)).toEqual({
      accepted: false,
      code: 'duplicate',
    });
  });

  it('rejects malformed log events and a durable per-Attempt log overflow', async () => {
    const malformed = { ...progress('event', 1), payload: { line: 'unbounded' } };
    expect(await repository.acceptWorkerMessage(request, malformed, 30_000)).toEqual({
      accepted: false,
      code: 'invalid_payload',
    });
    await prisma.executionAttemptMessage.createMany({
      data: Array.from({ length: 100 }, (_, index) => ({
        attemptId: request.execution.attemptId,
        sequence: index + 1,
        kind: 'event',
        eventType: 'plugin:log',
        payloadVersion: 1,
        payload: { level: 'info', message: 'ok', timestamp: 1 },
        occurredAt: new Date(),
      })),
    });
    expect(await repository.acceptWorkerMessage(request, progress('event', 1), 30_000)).toEqual({
      accepted: false,
      code: 'payload_too_large',
    });
    expect(
      (
        await prisma.executionAttempt.findUniqueOrThrow({
          where: { attemptId: request.execution.attemptId },
        })
      ).messageSequence,
    ).toBe(0);
  });

  it('rejects worker progress whose dispatch changes server-approved capability or deadline', async () => {
    const heartbeat = progress('heartbeat', 1);
    expect(
      await repository.acceptWorkerMessage(
        { ...request, requiredCapabilities: [] },
        heartbeat,
        30_000,
      ),
    ).toEqual({ accepted: false, code: 'invalid_payload' });
    expect(
      await repository.acceptWorkerMessage(
        { ...request, deadlineAt: new Date(Date.now() + 60_000).toISOString() },
        heartbeat,
        30_000,
      ),
    ).toEqual({ accepted: false, code: 'invalid_payload' });
    expect(
      await prisma.executionAttemptMessage.count({
        where: { attemptId: request.execution.attemptId },
      }),
    ).toBe(0);
  });

  it('rejects progress if the authoritative dispatch is absent', async () => {
    await prisma.executionAttempt.update({
      where: { attemptId: request.execution.attemptId },
      data: { dispatch: Prisma.DbNull },
    });
    expect(await repository.acceptWorkerMessage(request, progress('heartbeat', 1), 30_000)).toEqual(
      {
        accepted: false,
        code: 'invalid_payload',
      },
    );
  });

  it('rejects gaps, wrong tokens and expired leases without writing a message', async () => {
    expect(await repository.acceptWorkerMessage(request, progress('event', 2), 30_000)).toEqual({
      accepted: false,
      code: 'out_of_order',
    });
    expect(
      await repository.acceptWorkerMessage(
        request,
        { ...progress('event', 1), leaseToken: 'wrong' },
        30_000,
      ),
    ).toEqual({ accepted: false, code: 'stale_lease' });
    await prisma.executionAttempt.update({
      where: { attemptId: request.execution.attemptId },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    expect(await repository.acceptWorkerMessage(request, progress('event', 1), 30_000)).toEqual({
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
      repository.acceptWorkerMessage(request, progress('event', 1), 30_000),
      repository.acceptWorkerMessage(request, progress('event', 1), 30_000),
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
      (await repository.acceptWorkerMessage(request, progress('event', 1), 30_000)).accepted,
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
    expect(await repository.acceptWorkerMessage(request, progress('event', 2), 30_000)).toEqual({
      accepted: false,
      code: 'stale_lease',
    });
    expect(
      (
        await repository.acceptWorkerMessage(
          request,
          { ...progress('event', 2), leaseToken: 'token-2' },
          30_000,
        )
      ).accepted,
    ).toBe(true);
  });

  it.each([
    { success: true, status: AttemptStatuses.SUCCEEDED },
    { success: false, status: AttemptStatuses.FAILED },
  ])('atomically settles a $status completion once', async ({ success, status }) => {
    expect(await repository.readWorkerTerminal(request.execution)).toBeUndefined();
    const complete = {
      ...progress('heartbeat', 1),
      kind: 'complete' as const,
      result: { success, data: { value: 42 } },
    };
    expect((await repository.acceptWorkerMessage(request, complete, 30_000)).accepted).toBe(true);
    expect(await repository.readWorkerTerminal(request.execution)).toEqual({
      kind: 'complete',
      result: complete.result,
    });
    expect(
      await prisma.executionAttempt.findUniqueOrThrow({
        where: { attemptId: request.execution.attemptId },
      }),
    ).toMatchObject({ status, messageSequence: 1, result: complete.result });
    expect(
      (await prisma.executionJob.findUniqueOrThrow({ where: { jobId: request.execution.jobId } }))
        .status,
    ).toBe(status);
    expect(await repository.acceptWorkerMessage(request, complete, 30_000)).toEqual({
      accepted: false,
      code: 'duplicate',
    });
    expect(
      await prisma.executionAttemptMessage.count({
        where: { attemptId: request.execution.attemptId },
      }),
    ).toBe(1);
    expect(await prisma.runEvent.count({ where: { runId: request.runId } })).toBe(0);
  });

  it('atomically stores a wait checkpoint and leaves it wakeable once', async () => {
    const wait = {
      ...progress('heartbeat', 1),
      kind: 'wait' as const,
      checkpoint: { cursor: 3 },
      condition: { kind: 'signal' as const, key: 'approved' },
    };
    const waitRequest = { ...request, requiredCapabilities: ['execution.wait'] };
    expect((await repository.acceptWorkerMessage(waitRequest, wait, 30_000)).accepted).toBe(true);
    expect(await repository.readWorkerTerminal(request.execution)).toEqual({
      kind: 'wait',
      result: { success: true, wait: { checkpoint: wait.checkpoint, condition: wait.condition } },
    });
    await prisma.executionAttempt.update({
      where: { attemptId: request.execution.attemptId },
      data: { wakeKey: 'wrong' },
    });
    expect(await repository.readWorkerTerminal(request.execution)).toBeUndefined();
    await prisma.executionAttempt.update({
      where: { attemptId: request.execution.attemptId },
      data: { wakeKey: 'approved' },
    });
    expect(
      await prisma.executionAttempt.findUniqueOrThrow({
        where: { attemptId: request.execution.attemptId },
      }),
    ).toMatchObject({
      status: AttemptStatuses.WAITING,
      messageSequence: 1,
      wakeKey: 'approved',
      leaseExpiresAt: null,
    });
    expect(
      await prisma.executionJob.findUniqueOrThrow({ where: { jobId: request.execution.jobId } }),
    ).toMatchObject({
      status: AttemptStatuses.WAITING,
      checkpoint: {
        jobId: request.execution.jobId,
        sourceAttemptId: request.execution.attemptId,
        version: 1,
        payload: { cursor: 3 },
      },
    });
    expect(await repository.acceptWorkerMessage(waitRequest, wait, 30_000)).toEqual({
      accepted: false,
      code: 'duplicate',
    });
    const checkpoint = {
      jobId: request.execution.jobId,
      sourceAttemptId: request.execution.attemptId,
      version: 1,
      payload: { cursor: 3 },
      createdAt: new Date(Date.now() + 1000).toISOString(),
    };
    expect(
      await repository.confirmRegisteredWorkerWait(request.execution, checkpoint, wait.condition),
    ).toBe(true);
    expect(
      await repository.confirmRegisteredWorkerWait(
        request.execution,
        { ...checkpoint, payload: { cursor: 4 } },
        wait.condition,
      ),
    ).toBe(false);
    expect(
      await repository.confirmRegisteredWorkerWait(request.execution, checkpoint, {
        kind: 'signal',
        key: 'different',
      }),
    ).toBe(false);
    expect(
      await repository.signalWait(
        request.execution.attemptId,
        'approved',
        { yes: true },
        new Date(),
      ),
    ).toBe(true);
  });

  it('does not expose a terminal receipt with mismatched identity or Job state', async () => {
    const complete = {
      ...progress('heartbeat', 1),
      kind: 'complete' as const,
      result: { success: true, data: { value: 1 } },
    };
    expect((await repository.acceptWorkerMessage(request, complete, 30_000)).accepted).toBe(true);
    expect(
      await repository.readWorkerTerminal({ ...request.execution, attempt: 1 }),
    ).toBeUndefined();
    await repository.setJobStatus(request.execution.jobId, AttemptStatuses.RUNNING);
    expect(await repository.readWorkerTerminal(request.execution)).toBeUndefined();
  });

  it('rejects terminal writes from stale or expired leases without settling the job', async () => {
    const complete = {
      ...progress('heartbeat', 1),
      kind: 'complete' as const,
      result: { success: true },
    };
    expect(
      await repository.acceptWorkerMessage(
        request,
        { ...complete, leaseToken: 'wrong-token' },
        30_000,
      ),
    ).toEqual({ accepted: false, code: 'stale_lease' });
    await prisma.executionAttempt.update({
      where: { attemptId: request.execution.attemptId },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    expect(await repository.acceptWorkerMessage(request, complete, 30_000)).toEqual({
      accepted: false,
      code: 'expired_lease',
    });
    expect(
      await prisma.executionAttempt.findUniqueOrThrow({
        where: { attemptId: request.execution.attemptId },
      }),
    ).toMatchObject({ status: AttemptStatuses.RUNNING, messageSequence: 0, result: null });
    expect(
      (await prisma.executionJob.findUniqueOrThrow({ where: { jobId: request.execution.jobId } }))
        .status,
    ).toBe(AttemptStatuses.RUNNING);
  });

  it('settles only one of two racing terminal messages', async () => {
    const base = progress('heartbeat', 1);
    const [success, failure] = await Promise.all([
      repository.acceptWorkerMessage(
        request,
        { ...base, kind: 'complete', result: { success: true } },
        30_000,
      ),
      repository.acceptWorkerMessage(
        request,
        { ...base, kind: 'complete', result: { success: false } },
        30_000,
      ),
    ]);
    expect([success, failure].filter((decision) => decision.accepted)).toHaveLength(1);
    expect(
      await prisma.executionAttemptMessage.count({
        where: { attemptId: request.execution.attemptId },
      }),
    ).toBe(1);
    const attempt = await prisma.executionAttempt.findUniqueOrThrow({
      where: { attemptId: request.execution.attemptId },
    });
    const job = await prisma.executionJob.findUniqueOrThrow({
      where: { jobId: request.execution.jobId },
    });
    expect(attempt.status).toBe(job.status);
    expect(attempt.status).toBe(
      success.accepted ? AttemptStatuses.SUCCEEDED : AttemptStatuses.FAILED,
    );
  });

  it('projects a settled success once under the Run lease for DAG recovery', async () => {
    const complete = {
      ...progress('heartbeat', 1),
      kind: 'complete' as const,
      result: { success: true, data: { value: 42 } },
    };
    expect((await repository.acceptWorkerMessage(request, complete, 30_000)).accepted).toBe(true);
    await prisma.run.update({
      where: { runId: request.runId },
      data: {
        leaseOwner: 'server-2',
        leaseToken: 'run-token',
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    await expect(repository.projectSettledWorkerAttempts(request.runId, 'wrong')).rejects.toThrow(
      /Run lease unavailable/,
    );
    expect(await repository.projectSettledWorkerAttempts(request.runId, 'run-token')).toBe(1);
    expect(await repository.projectSettledWorkerAttempts(request.runId, 'run-token')).toBe(0);
    const row = await prisma.run.findUniqueOrThrow({
      where: { runId: request.runId },
      include: { events: { orderBy: { eventIndex: 'asc' } } },
    });
    expect(row.countsCompleted).toBe(1);
    expect(row.events).toHaveLength(1);
    const snapshot = buildRunRecoverySnapshot(
      toRunRecord(row, row.events),
      await repository.listJobsForRun(request.runId),
    );
    expect(snapshot.completedResults).toMatchObject([
      { stepId: 'step', pluginResult: { success: true, data: { value: 42 } } },
    ]);
    let pluginCalls = 0;
    const executor = createWorkflowExecutor({
      pluginExecutor: async () => {
        pluginCalls += 1;
        return { success: true };
      },
    });
    const resumed = await executor.executeWorkflow(
      request.runId,
      toRunRecord(row, row.events).workflowSnapshot,
      {},
      { resume: snapshot },
    );
    expect(resumed.success).toBe(true);
    expect(pluginCalls).toBe(0);
  });
});
