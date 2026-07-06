import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTaskScheduler } from '../scheduler/index.js';

describe('scheduler cancel', () => {
  it('cancelScheduledTask removes queued task', async () => {
    const scheduler = createTaskScheduler({ maxConcurrency: 1 });
    let firstStarted = false;
    let secondRan = false;

    const first = scheduler.scheduleTask({
      id: 't1',
      name: 't1',
      priority: 0,
      createdAt: new Date(),
      execute: async () => {
        firstStarted = true;
        await new Promise((r) => setTimeout(r, 50));
        return 'first';
      },
    });

    const second = scheduler.scheduleTask({
      id: 't2',
      name: 't2',
      priority: 0,
      createdAt: new Date(),
      workflowRunId: 'run-2',
      execute: async () => {
        secondRan = true;
        return 'second';
      },
    });

    await new Promise((r) => setTimeout(r, 5));
    const cancelled = scheduler.cancelScheduledTask('t2');
    assert.equal(cancelled, true);

    const secondResult = await second;
    assert.equal(secondResult.cancelled, true);
    assert.equal(secondResult.success, false);
    assert.equal(secondRan, false);

    await first;
    assert.equal(firstStarted, true);
  });

  it('cancelScheduledTaskByWorkflowRunId cancels by run id', async () => {
    const scheduler = createTaskScheduler({ maxConcurrency: 1 });

    scheduler.scheduleTask({
      id: 'blocker',
      name: 'blocker',
      priority: 0,
      createdAt: new Date(),
      execute: async () => {
        await new Promise((r) => setTimeout(r, 50));
      },
    });

    const pending = scheduler.scheduleTask({
      id: 'queued',
      name: 'queued',
      priority: 0,
      createdAt: new Date(),
      workflowRunId: 'wf-run-1',
      execute: async () => 'ok',
    });

    await new Promise((r) => setTimeout(r, 5));
    assert.equal(scheduler.cancelScheduledTaskByWorkflowRunId('wf-run-1'), true);
    const result = await pending;
    assert.equal(result.cancelled, true);
  });
});
