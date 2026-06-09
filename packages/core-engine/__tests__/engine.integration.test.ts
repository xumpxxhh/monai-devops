import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../engine/index.js';
import { StepStatuses } from '../errors.js';
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

describe('createEngine integration', () => {
  it('runs workflow with registered plugin', async () => {
    const engine = createEngine({
      plugins: [testPlugin],
      maxParallelSteps: 2,
    });

    const run = await engine.runWorkflow({
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
    const result = await engine.scheduleWorkflow({
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

  it('queues step when resource unavailable then completes after register', async () => {
    const engine = createEngine({
      plugins: [testPlugin],
      resources: { autoCleanup: false },
    });

    const runPromise = engine.runWorkflow({
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
    assert.equal(engine.getResourceScheduler().getQueueStatus('runner').queueLength, 1);

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

    const run = await engine.runWorkflow({
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
});
