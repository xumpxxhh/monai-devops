import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../engine/index.js';
import { StepStatuses, ResourceRegistrationError } from '../errors.js';
import { createPlugin } from '@monai-devops/plugin-sdk';

const testPlugin = createPlugin({
  name: 'test-plugin',
  version: '1.0.0',
  execute: async (config) => {
    const type = config.type as string;
    if (type === 'unit') {
      return { success: true, message: '单元测试执行成功', data: { type } };
    }
    return { success: false, message: `未知的测试类型: ${type}` };
  },
});

const TEST_RUN_ID = 'test-run-id';

describe('createEngine integration', () => {
  it('runs workflow with registered plugin', async () => {
    const engine = createEngine({
      plugins: [testPlugin],
      maxParallelSteps: 2,
    });

    const run = await engine.runWorkflow(TEST_RUN_ID, {
      id: 'wf-1',
      name: 'test workflow',
      steps: [
        {
          id: 'step1',
          name: 'Unit test',
          plugin: 'test-plugin',
          config: { type: 'unit' },
        },
      ],
    });

    assert.equal(run.success, true);
    assert.equal(run.results[0]?.pluginResult?.message, '单元测试执行成功');
    engine.destroy();
  });

  it('scheduleWorkflow executes via scheduler', async () => {
    const engine = createEngine({ plugins: [testPlugin] });
    const result = await engine.scheduleWorkflow('scheduled-run-id', {
      id: 'wf-2',
      name: 'scheduled',
      steps: [
        {
          id: 's1',
          name: 'step',
          plugin: 'test-plugin',
          config: { type: 'unit' },
        },
      ],
    });

    assert.equal(result.success, true);
    const run = result.result as { success: boolean };
    assert.equal(run.success, true);
    engine.destroy();
  });

  it('scheduleWorkflow forwards callOptions to runWorkflow', async () => {
    const engine = createEngine({ plugins: [testPlugin] });
    const result = await engine.scheduleWorkflow(
      'scheduled-call-options-run',
      {
        id: 'wf-no-state',
        name: 'no state schema',
        steps: [
          {
            id: 's1',
            name: 'step',
            plugin: 'test-plugin',
            config: { type: 'unit' },
          },
        ],
      },
      {},
      { initialState: { count: 1 } },
    );
    assert.equal(result.success, false);
    assert.ok(
      result.error instanceof Error &&
        /未声明 stateSchema，不允许传入 initialState/.test(result.error.message),
    );
    engine.destroy();
  });

  it('queues step when resource unavailable then completes after register', async () => {
    const engine = createEngine({
      plugins: [testPlugin],
      resources: { autoCleanup: false },
    });

    const runPromise = engine.runWorkflow('queued-run-id', {
      id: 'wf-3',
      name: 'queued resource',
      steps: [
        {
          id: 's1',
          name: 'needs runner',
          plugin: 'test-plugin',
          config: { type: 'unit', resourceType: 'runner' },
        },
      ],
    });

    await new Promise((r) => setTimeout(r, 30));
    assert.equal(engine.getResourceWaitQueue().getQueueStatus('runner').queueLength, 1);

    engine.getResourceManager().registerResource({
      id: 'r1',
      type: 'runner',
      name: 'runner-1',
      status: 'available',
    });

    const run = await runPromise;
    assert.equal(run.success, true);
    assert.equal(run.results[0]?.status, StepStatuses.COMPLETED);
    engine.destroy();
  });

  it('runs competing steps sequentially with one runner', async () => {
    const engine = createEngine({
      plugins: [testPlugin],
      maxParallelSteps: 2,
      resources: { autoCleanup: false },
    });

    engine.getResourceManager().registerResource({
      id: 'r1',
      type: 'runner',
      name: 'runner-1',
      status: 'available',
    });

    const run = await engine.runWorkflow(TEST_RUN_ID, {
      id: 'wf-4',
      name: 'compete',
      steps: [
        {
          id: 's1',
          name: 'first',
          plugin: 'test-plugin',
          config: { type: 'unit', resourceType: 'runner' },
        },
        {
          id: 's2',
          name: 'second',
          plugin: 'test-plugin',
          config: { type: 'unit', resourceType: 'runner' },
        },
      ],
    });

    assert.equal(run.success, true);
    assert.equal(run.results.length, 2);
    engine.destroy();
  });

  it('defers resource release until plugin settles after in-flight abort timeout', async () => {
    let finishStep!: () => void;
    const stepGate = new Promise<void>((resolve) => {
      finishStep = resolve;
    });

    const engine = createEngine({
      defaultPoolSize: 1,
      inFlightTimeoutMs: 50,
      plugins: [
        createPlugin({
          name: 'slow',
          version: '1.0.0',
          execute: async () => {
            await stepGate;
            return { success: true, data: {} };
          },
        }),
      ],
    });

    const workflow = {
      id: 'defer-release',
      name: 'defer-release',
      steps: [{ id: 'a', name: 'A', plugin: 'slow', config: {} }],
    };

    const runPromise = engine.runWorkflow('defer-run', workflow);
    await new Promise((r) => setTimeout(r, 20));
    await engine.cancelRun('defer-run', { mode: 'hard' });
    await new Promise((r) => setTimeout(r, 80));

    assert.equal(engine.getResourceManager().getAvailableResources('default').length, 0);

    finishStep();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(engine.getResourceManager().getAvailableResources('default').length, 1);

    const run = await runPromise;
    assert.equal(run.status, 'cancelled');
    await engine.destroy();
  });

  it('scheduleWorkflow does not retry on infrastructure throw', async () => {
    const engine = createEngine({
      plugins: [testPlugin],
      scheduler: { retryAttempts: 5, retryDelay: 100 },
    });

    const cyclic = {
      id: 'cycle',
      name: 'cycle',
      steps: [
        {
          id: 'a',
          name: 'A',
          plugin: 'test-plugin',
          config: { type: 'unit' },
          dependsOn: ['b'],
        },
        {
          id: 'b',
          name: 'B',
          plugin: 'test-plugin',
          config: { type: 'unit' },
          dependsOn: ['a'],
        },
      ],
    };

    const started = Date.now();
    const result = await engine.scheduleWorkflow('cycle-run', cyclic);
    assert.equal(result.success, false);
    assert.ok(Date.now() - started < 80);
    engine.destroy();
  });

  it('throws ResourceRegistrationError when pool capacity is insufficient at construction', () => {
    assert.throws(
      () =>
        createEngine({
          defaultPoolSize: 8,
          resources: { maxResources: 10 },
          initialResources: Array.from({ length: 5 }, (_, i) => ({
            id: `extra-${i}`,
            type: 'runner',
            name: `runner-${i}`,
            status: 'available' as const,
          })),
        }),
      ResourceRegistrationError,
    );
  });

  it('throws ResourceRegistrationError when dynamic register exceeds pool limit', () => {
    const engine = createEngine({
      defaultPoolSize: 1,
      resources: { maxResources: 1 },
    });

    assert.throws(
      () =>
        engine.registerResource({
          id: 'overflow',
          type: 'runner',
          name: 'runner-overflow',
          status: 'available',
        }),
      ResourceRegistrationError,
    );
    engine.destroy();
  });
});
