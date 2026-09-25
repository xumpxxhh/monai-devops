import { jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import type { WorkflowRunResult } from '@monai-devops/core-engine';
import { assertTestDatabaseUrl } from '../common/storage/assert-test-database-url.js';
import type { EngineService } from '../engine/engine.service.js';
import type { ExecutionLeaseService } from '../execution/execution-lease.service.js';
import type { ExecutionRepository } from '../execution/execution.repository.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { RunRecord } from './runs.repository.js';
import { PrismaRunRepository } from './prisma-run.repository.js';
import { RunManagerService } from './run-manager.service.js';
import type { RunStreamService } from './run-stream.service.js';
import type { SerializedWorkflowLifecycleEvent } from '../common/serialization/serialize-workflow-event.js';

const databaseUrl = process.env.DATABASE_URL?.trim();
const describeIfDb = databaseUrl ? describe : describe.skip;

function streamLog(
  stepId: string,
  message: string,
  stream: 'stdout' | 'stderr' = 'stdout',
): SerializedWorkflowLifecycleEvent {
  return {
    type: 'plugin:log',
    workflowRunId: 'run-1',
    meta: { workflowId: 'wf-1' },
    step: { id: stepId, name: stepId, plugin: 'test-plugin' },
    log: { level: 'info', message, timestamp: Date.now(), stream },
  };
}

function baseRecord(runId = 'run-prisma-1'): RunRecord {
  return {
    runId,
    workflowId: 'wf-1',
    workflowSnapshot: {
      id: 'wf-1',
      name: 'Test Workflow',
      steps: [{ id: 's1', name: 'S1', plugin: 'test-plugin', config: {} }],
    },
    status: 'running',
    counts: { total: 1, completed: 0, failed: 0, skipped: 0 },
    createdAt: new Date(),
    events: [],
  };
}

describeIfDb('PrismaRunRepository integration', () => {
  const prisma = new PrismaService();
  const config = {
    get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
  } as unknown as ConfigService;
  const repository = new PrismaRunRepository(prisma, config);

  beforeAll(async () => {
    assertTestDatabaseUrl();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    assertTestDatabaseUrl();
    await prisma.runEvent.deleteMany();
    await prisma.run.deleteMany();
  });

  it('persists and loads runs with events', async () => {
    await repository.save(baseRecord());

    const loaded = await repository.findById('run-prisma-1');
    expect(loaded?.workflowSnapshot.name).toBe('Test Workflow');
    expect(loaded?.events).toEqual([]);
  });

  it('stores initial recovery state privately, outside Run responses', async () => {
    await repository.save(baseRecord(), { secret: 'private', count: 1 });

    expect(await repository.getRecoveryState('run-prisma-1')).toEqual({
      present: true,
      value: { secret: 'private', count: 1 },
    });
    await expect(repository.findById('run-prisma-1')).resolves.not.toHaveProperty('recoveryState');
  });

  it('allows only one Run lease owner and fences heartbeat/release by token', async () => {
    await repository.save(baseRecord());
    const expiration = () => new Date(Date.now() + 60_000);
    const claims = await Promise.all([
      repository.acquireRunLease('run-prisma-1', 'owner-a', 'token-a', expiration()),
      repository.acquireRunLease('run-prisma-1', 'owner-b', 'token-b', expiration()),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const winner = claims[0] ? 'token-a' : 'token-b';
    const loser = claims[0] ? 'token-b' : 'token-a';
    expect(await repository.heartbeatRunLease('run-prisma-1', loser, expiration())).toBe(false);
    expect(await repository.heartbeatRunLease('run-prisma-1', winner, expiration())).toBe(true);
    expect(await repository.releaseRunLease('run-prisma-1', loser)).toBe(false);
    expect(await repository.releaseRunLease('run-prisma-1', winner)).toBe(true);
    expect(
      await repository.acquireRunLease('run-prisma-1', 'owner-c', 'token-c', expiration()),
    ).toBe(true);
  });

  it('permits takeover only after the old lease expires', async () => {
    await repository.save(baseRecord());
    expect(
      await repository.acquireRunLease(
        'run-prisma-1',
        'old-owner',
        'old-token',
        new Date(Date.now() + 60_000),
      ),
    ).toBe(true);
    expect(
      await repository.acquireRunLease(
        'run-prisma-1',
        'new-owner',
        'new-token',
        new Date(Date.now() + 60_000),
      ),
    ).toBe(false);
    await prisma.run.update({
      where: { runId: 'run-prisma-1' },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    expect(
      await repository.acquireRunLease(
        'run-prisma-1',
        'new-owner',
        'new-token',
        new Date(Date.now() + 60_000),
      ),
    ).toBe(true);
    expect(
      await repository.heartbeatRunLease(
        'run-prisma-1',
        'old-token',
        new Date(Date.now() + 60_000),
      ),
    ).toBe(false);
  });

  it('lists only old unleased or expired top-level Runs for recovery', async () => {
    const old = baseRecord('old-queued');
    old.status = 'queued';
    old.createdAt = new Date(Date.now() - 60_000);
    await repository.save(old);
    const recent = baseRecord('recent-queued');
    recent.status = 'queued';
    await repository.save(recent);
    await repository.save(baseRecord('expired-running'));
    await repository.save(baseRecord('live-running'));
    const until = new Date(Date.now() + 60_000);
    expect(await repository.acquireRunLease('expired-running', 'old', 'expired-token', until)).toBe(
      true,
    );
    expect(await repository.acquireRunLease('live-running', 'live', 'live-token', until)).toBe(
      true,
    );
    await prisma.run.update({
      where: { runId: 'expired-running' },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });

    const ids = await repository.listRecoverableRunIds(
      new Date(),
      new Date(Date.now() - 5_000),
      10,
    );
    expect(ids).toEqual(expect.arrayContaining(['old-queued', 'expired-running']));
    expect(ids).not.toEqual(expect.arrayContaining(['recent-queued', 'live-running']));
  });

  it('starts a persisted Run only once when two managers race to recover it', async () => {
    const queued = baseRecord();
    queued.status = 'queued';
    queued.workflowSnapshot.steps = [];
    queued.counts.total = 0;
    await repository.save(queued);

    let finish!: (result: WorkflowRunResult) => void;
    const pending = new Promise<WorkflowRunResult>((resolve) => {
      finish = resolve;
    });
    const engine = { runWorkflow: jest.fn(async () => pending) } as unknown as EngineService;
    const executions = {
      listJobsForRun: jest.fn(async () => []),
    } as unknown as ExecutionRepository;
    const streams = { fanOut: jest.fn() } as unknown as RunStreamService;
    const makeManager = () =>
      new RunManagerService(
        engine,
        repository,
        streams,
        config,
        executions,
        {} as ExecutionLeaseService,
        { request: jest.fn() } as never,
      );
    const first = makeManager();
    const second = makeManager();

    const accepted = await Promise.all([
      first.resumePersistedRun(queued.runId),
      second.resumePersistedRun(queued.runId),
    ]);
    expect(accepted.filter(Boolean)).toHaveLength(1);
    expect(engine.runWorkflow).toHaveBeenCalledTimes(1);
    expect(engine.runWorkflow).toHaveBeenCalledWith(
      queued.runId,
      queued.workflowSnapshot,
      expect.any(Object),
      { resume: { completedResults: [], nextAttemptByStep: {} } },
    );

    finish({ success: true, status: 'success', workflowId: 'wf-1', results: [] });
    for (let i = 0; i < 50; i++) {
      if ((await repository.findById(queued.runId))?.status === 'finished') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await repository.findById(queued.runId))?.status).toBe('finished');
    first.onModuleDestroy();
    second.onModuleDestroy();
  });

  it('releases ownership without executing when a recovery snapshot is invalid', async () => {
    const blocked = baseRecord('blocked-recovery');
    blocked.status = 'queued';
    blocked.workflowSnapshot.stateSchema = {
      type: 'object',
      properties: { count: { type: 'number' } },
      required: ['count'],
    };
    await repository.save(blocked);
    const engine = { runWorkflow: jest.fn() } as unknown as EngineService;
    const manager = new RunManagerService(
      engine,
      repository,
      { fanOut: jest.fn() } as unknown as RunStreamService,
      config,
      { listJobsForRun: jest.fn(async () => []) } as unknown as ExecutionRepository,
      {} as ExecutionLeaseService,
      { request: jest.fn() } as never,
    );

    await expect(manager.resumePersistedRun(blocked.runId)).rejects.toThrow(/缺少可恢复 state/);
    expect(engine.runWorkflow).not.toHaveBeenCalled();
    const row = await prisma.run.findUniqueOrThrow({ where: { runId: blocked.runId } });
    expect(row.status).toBe('queued');
    expect(row.leaseToken).toBeNull();
  });

  it('settles a permanently unrecoverable Run once during automatic recovery', async () => {
    const blocked = baseRecord('blocked-auto-recovery');
    blocked.status = 'queued';
    blocked.workflowSnapshot.stateSchema = {
      type: 'object',
      properties: { count: { type: 'number' } },
      required: ['count'],
    };
    await repository.save(blocked);
    const engine = { runWorkflow: jest.fn() } as unknown as EngineService;
    const manager = new RunManagerService(
      engine,
      repository,
      { fanOut: jest.fn() } as unknown as RunStreamService,
      config,
      { listJobsForRun: jest.fn(async () => []) } as unknown as ExecutionRepository,
      {} as ExecutionLeaseService,
      { request: jest.fn() } as never,
    );

    expect(await manager.resumePersistedRun(blocked.runId, true)).toBe(true);
    expect(await manager.resumePersistedRun(blocked.runId, true)).toBe(false);
    expect(engine.runWorkflow).not.toHaveBeenCalled();
    const row = await prisma.run.findUniqueOrThrow({ where: { runId: blocked.runId } });
    expect(row).toMatchObject({ status: 'failed', isActive: false, leaseToken: null });
    expect(row.result).toMatchObject({
      status: 'failed',
      terminalReason: 'recovery_blocked',
      terminalMessage: expect.stringMatching(/缺少可恢复 state/),
    });
    expect(await prisma.runEvent.count({ where: { runId: blocked.runId } })).toBe(1);
  });

  it('fences recovery settlement by lease token and reuses an existing terminal event', async () => {
    const record = baseRecord('terminal-projection-lost');
    record.events = [
      {
        type: 'workflow:finished',
        workflowRunId: record.runId,
        result: { success: true, status: 'success', workflowId: record.workflowId, results: [] },
      },
    ];
    await repository.save(record);
    expect(
      await repository.acquireRunLease(
        record.runId,
        'owner',
        'current-token',
        new Date(Date.now() + 60_000),
      ),
    ).toBe(true);
    expect(await repository.settleRecoveryBlocked(record.runId, 'old-token', 'stale')).toBe(false);
    expect(
      await repository.settleRecoveryBlocked(record.runId, 'current-token', 'projection lost'),
    ).toBe(true);
    expect(await repository.settleRecoveryBlocked(record.runId, 'current-token', 'again')).toBe(
      false,
    );
    expect((await repository.findById(record.runId))?.status).toBe('finished');
    expect(await prisma.runEvent.count({ where: { runId: record.runId } })).toBe(1);
  });

  it('merges consecutive stream logs on appendEvent', async () => {
    await repository.save(baseRecord());
    await repository.appendEvent('run-prisma-1', streamLog('s1', 'line1\n'));
    await repository.appendEvent('run-prisma-1', streamLog('s1', 'line2\n'));

    const loaded = await repository.findById('run-prisma-1');
    expect(loaded?.events).toHaveLength(1);
    expect((loaded?.events[0]?.log as { message: string }).message).toBe('line1\nline2\n');
  });

  it('lists runs with active-first ordering', async () => {
    const finished = baseRecord('run-finished');
    finished.status = 'finished';
    finished.createdAt = new Date('2026-01-02T00:00:00Z');

    const running = baseRecord('run-running');
    running.status = 'running';
    running.createdAt = new Date('2026-01-01T00:00:00Z');

    await repository.save(finished);
    await repository.save(running);

    const { items } = await repository.list({ page: 1, pageSize: 10 });
    expect(items[0]?.runId).toBe('run-running');
    expect(items[1]?.runId).toBe('run-finished');
  });

  it('counts active and terminal runs', async () => {
    await repository.save(baseRecord('run-active'));
    const finished = baseRecord('run-finished');
    finished.status = 'finished';
    await repository.save(finished);

    expect(await repository.countActive()).toBe(1);
    expect(await repository.countByStatus('finished')).toBe(1);
  });
});
