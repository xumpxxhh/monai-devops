import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ResourceQueueCancelledError } from '../errors.js';
import { createResourceManager } from '../resource/index.js';
import { createResourceStepScheduler } from '../resource-scheduler/index.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function createPool(autoCleanup = false) {
  return createResourceManager({ autoCleanup, maxResources: 10 });
}

describe('resource-scheduler', () => {
  it('acquires immediately when resource is available', async () => {
    const rm = createPool();
    rm.registerResource({
      id: 'r1',
      type: 'runner',
      name: 'runner-1',
      status: 'available',
    });

    const scheduler = createResourceStepScheduler({ resourceManager: rm });
    const result = await scheduler.acquire({
      id: 'run1:s1',
      runId: 'run1',
      resourceType: 'runner',
      priority: 0,
    });

    assert.equal(result.resourceId, 'r1');
    result.release();
    rm.destroy();
    scheduler.destroy();
  });

  it('queues second acquire until first releases', async () => {
    const rm = createPool();
    rm.registerResource({
      id: 'r1',
      type: 'runner',
      name: 'runner-1',
      status: 'available',
    });

    const scheduler = createResourceStepScheduler({ resourceManager: rm });
    const order: string[] = [];

    const first = await scheduler.acquire({
      id: 'run1:s1',
      runId: 'run1',
      resourceType: 'runner',
      priority: 0,
    });
    order.push('first-acquired');

    const secondPromise = scheduler
      .acquire({
        id: 'run1:s2',
        runId: 'run1',
        resourceType: 'runner',
        priority: 0,
        enqueuedAt: new Date(),
      })
      .then((r) => {
        order.push('second-acquired');
        r.release();
      });

    await delay(20);
    assert.deepEqual(order, ['first-acquired']);
    assert.equal(scheduler.getQueueStatus('runner').queueLength, 1);

    first.release();
    await secondPromise;
    assert.deepEqual(order, ['first-acquired', 'second-acquired']);

    rm.destroy();
    scheduler.destroy();
  });

  it('schedules by lower priority number first', async () => {
    const rm = createPool();
    rm.registerResource({
      id: 'r1',
      type: 'gpu',
      name: 'gpu-1',
      status: 'available',
    });

    const scheduler = createResourceStepScheduler({ resourceManager: rm });
    const order: string[] = [];

    const hold = await scheduler.acquire({
      id: 'hold',
      runId: 'run-hold',
      resourceType: 'gpu',
      priority: 0,
    });

    const low = scheduler.acquire({
      id: 'low',
      runId: 'run-low',
      resourceType: 'gpu',
      priority: 10,
      enqueuedAt: new Date('2024-01-01T00:00:00.000Z'),
    });
    const high = scheduler.acquire({
      id: 'high',
      runId: 'run-high',
      resourceType: 'gpu',
      priority: 1,
      enqueuedAt: new Date('2024-01-01T00:00:01.000Z'),
    });

    void low.then((r) => {
      order.push('low');
      r.release();
    });
    void high.then((r) => {
      order.push('high');
      r.release();
    });

    await delay(10);
    hold.release();
    await Promise.all([low, high]);

    assert.deepEqual(order, ['high', 'low']);
    rm.destroy();
    scheduler.destroy();
  });

  it('schedules same priority in FIFO order', async () => {
    const rm = createPool();
    rm.registerResource({
      id: 'r1',
      type: 'slot',
      name: 'slot-1',
      status: 'available',
    });

    const scheduler = createResourceStepScheduler({ resourceManager: rm });
    const order: string[] = [];

    const hold = await scheduler.acquire({
      id: 'hold',
      runId: 'run-hold',
      resourceType: 'slot',
      priority: 0,
    });

    const base = new Date('2024-06-01T00:00:00.000Z');
    const first = scheduler.acquire({
      id: 'first',
      runId: 'run-1',
      resourceType: 'slot',
      priority: 5,
      enqueuedAt: new Date(base.getTime()),
    });
    const second = scheduler.acquire({
      id: 'second',
      runId: 'run-2',
      resourceType: 'slot',
      priority: 5,
      enqueuedAt: new Date(base.getTime() + 1000),
    });

    void first.then((r) => {
      order.push('first');
      r.release();
    });
    void second.then((r) => {
      order.push('second');
      r.release();
    });

    hold.release();
    await Promise.all([first, second]);

    assert.deepEqual(order, ['first', 'second']);
    rm.destroy();
    scheduler.destroy();
  });

  it('isolates queues by resourceType', async () => {
    const rm = createPool();
    rm.registerResource({
      id: 'gpu-1',
      type: 'gpu',
      name: 'gpu',
      status: 'available',
    });
    rm.registerResource({
      id: 'runner-1',
      type: 'runner',
      name: 'runner',
      status: 'available',
    });

    const scheduler = createResourceStepScheduler({ resourceManager: rm });

    const gpuHold = await scheduler.acquire({
      id: 'gpu-hold',
      runId: 'run-gpu',
      resourceType: 'gpu',
      priority: 0,
    });

    const runner = await scheduler.acquire({
      id: 'runner-1',
      runId: 'run-runner',
      resourceType: 'runner',
      priority: 0,
    });

    assert.equal(runner.resourceId, 'runner-1');
    runner.release();
    gpuHold.release();

    rm.destroy();
    scheduler.destroy();
  });

  it('cancelByRunId rejects waiting acquire', async () => {
    const rm = createPool();
    rm.registerResource({
      id: 'r1',
      type: 'runner',
      name: 'runner-1',
      status: 'available',
    });

    const scheduler = createResourceStepScheduler({ resourceManager: rm });
    const hold = await scheduler.acquire({
      id: 'hold',
      runId: 'run-hold',
      resourceType: 'runner',
      priority: 0,
    });

    const waiting = scheduler.acquire({
      id: 'wait',
      runId: 'run-cancel',
      resourceType: 'runner',
      priority: 0,
    });

    await delay(10);
    assert.equal(scheduler.cancelByRunId('run-cancel'), 1);

    await assert.rejects(waiting, ResourceQueueCancelledError);
    hold.release();

    rm.destroy();
    scheduler.destroy();
  });

  it('wakes queue when resource is registered later', async () => {
    let scheduler!: ReturnType<typeof createResourceStepScheduler>;
    const rm = createResourceManager({
      autoCleanup: false,
      maxResources: 10,
      onResourceAvailable: (type) => scheduler.notifyResourceAvailable(type),
    });
    scheduler = createResourceStepScheduler({ resourceManager: rm });

    const waiting = scheduler.acquire({
      id: 'wait',
      runId: 'run-1',
      resourceType: 'runner',
      priority: 0,
    });

    await delay(10);
    assert.equal(scheduler.getQueueStatus('runner').queueLength, 1);

    rm.registerResource({
      id: 'r1',
      type: 'runner',
      name: 'runner-1',
      status: 'available',
    });

    const result = await waiting;
    assert.equal(result.resourceId, 'r1');
    result.release();

    rm.destroy();
    scheduler.destroy();
  });
});
