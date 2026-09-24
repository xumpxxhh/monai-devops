import { jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import { assertTestDatabaseUrl } from '../common/storage/assert-test-database-url.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { RunRecord } from './runs.repository.js';
import { PrismaRunRepository } from './prisma-run.repository.js';
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
