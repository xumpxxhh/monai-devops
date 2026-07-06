import type { ConfigService } from '@nestjs/config';
import type { RunRecord } from './runs.repository.js';
import { InMemoryRunRepository } from './in-memory-run.repository.js';
import type { SerializedWorkflowLifecycleEvent } from '../common/serialization/serialize-workflow-event.js';

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

function baseRecord(): RunRecord {
  return {
    runId: 'run-1',
    workflowId: 'wf-1',
    workflowSnapshot: {
      id: 'wf-1',
      name: 'Test',
      steps: [{ id: 's1', name: 'S1', plugin: 'test-plugin', config: {} }],
    },
    status: 'running',
    counts: { total: 1, completed: 0, failed: 0, skipped: 0 },
    createdAt: new Date(),
    events: [],
  };
}

describe('InMemoryRunRepository.appendEvent stream merge', () => {
  const config = {
    get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
  } as unknown as ConfigService;

  const repository = new InMemoryRunRepository(config);

  beforeEach(async () => {
    await repository.save(baseRecord());
  });

  it('merges consecutive stdout stream logs into one event', async () => {
    await repository.appendEvent('run-1', streamLog('s1', 'line1\n'));
    await repository.appendEvent('run-1', streamLog('s1', 'line2\n'));
    await repository.appendEvent('run-1', streamLog('s1', 'line3\n'));

    const record = await repository.findById('run-1');
    expect(record?.events).toHaveLength(1);
    expect((record?.events[0].log as { message: string }).message).toBe('line1\nline2\nline3\n');
  });

  it('does not merge when lifecycle event breaks the chain', async () => {
    await repository.appendEvent('run-1', streamLog('s1', 'line1\n'));
    await repository.appendEvent('run-1', {
      type: 'step:finished',
      workflowRunId: 'run-1',
      meta: { workflowId: 'wf-1' },
      step: { id: 's1', name: 'S1', plugin: 'test-plugin' },
      result: { status: 'completed', success: true, stepId: 's1' },
    });
    await repository.appendEvent('run-1', streamLog('s1', 'line2\n'));

    const record = await repository.findById('run-1');
    expect(record?.events).toHaveLength(3);
    expect((record?.events[0].log as { message: string }).message).toBe('line1\n');
    expect((record?.events[2].log as { message: string }).message).toBe('line2\n');
  });

  it('keeps stdout and stderr as separate merged chains', async () => {
    await repository.appendEvent('run-1', streamLog('s1', 'out1\n', 'stdout'));
    await repository.appendEvent('run-1', streamLog('s1', 'err1\n', 'stderr'));
    await repository.appendEvent('run-1', streamLog('s1', 'out2\n', 'stdout'));
    await repository.appendEvent('run-1', streamLog('s1', 'err2\n', 'stderr'));

    const record = await repository.findById('run-1');
    expect(record?.events).toHaveLength(4);
    expect((record?.events[0].log as { message: string; stream: string }).message).toBe('out1\n');
    expect((record?.events[1].log as { message: string; stream: string }).message).toBe('err1\n');
    expect((record?.events[2].log as { message: string; stream: string }).message).toBe('out2\n');
    expect((record?.events[3].log as { message: string; stream: string }).message).toBe('err2\n');
  });
});
