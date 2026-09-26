import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPlugin, PluginContextKeys } from '@monai-devops/plugin-sdk';
import { createEngine } from '../engine/index.js';
import { createWorkflowExecutor, createLocalPluginAdapter } from '../executor/index.js';

describe('local plugin adapter', () => {
  it('routes resolved config and live context through the adapter, ahead of the legacy callback', async () => {
    let legacyCalled = false;
    const adapter = createLocalPluginAdapter(async (name, config, context) => {
      assert.equal(name, 'local-plugin');
      assert.equal(config.value, 7);
      assert.equal(context.stepId, 'step-1');
      assert.ok(context.execution);
      assert.ok(context[PluginContextKeys.logger]);
      return { success: true, data: { adapter: 'local' } };
    });
    assert.equal(adapter.kind, 'local');
    const executor = createWorkflowExecutor({
      pluginAdapter: adapter,
      pluginExecutor: async () => {
        legacyCalled = true;
        return { success: false };
      },
    });
    const result = await executor.executeWorkflow('local-adapter-run', {
      id: 'local-adapter-workflow',
      name: 'local adapter',
      steps: [{ id: 'step-1', name: 'Step 1', plugin: 'local-plugin', config: { value: 7 } }],
    });
    assert.equal(result.success, true);
    assert.equal(legacyCalled, false);
    assert.deepEqual(result.results[0]?.pluginResult?.data, { adapter: 'local' });
  });

  it('keeps plugin-manager failure conversion and run behavior via createEngine', async () => {
    const engine = createEngine({
      plugins: [
        createPlugin({
          name: 'throws',
          version: '1.0.0',
          execute: async () => {
            throw new Error('expected failure');
          },
        }),
      ],
    });
    const run = await engine.runWorkflow('local-failure-run', {
      id: 'local-failure-workflow',
      name: 'local failure',
      steps: [{ id: 's1', name: 'S1', plugin: 'throws', config: {} }],
    });
    assert.equal(run.success, false);
    assert.match(run.results[0]?.pluginResult?.message ?? '', /expected failure/);
    await engine.destroy();
  });

  it('uses an explicit execution override only when it returns a result', async () => {
    const engine = createEngine({
      plugins: [
        createPlugin({
          name: 'route-test',
          version: '1.0.0',
          execute: async () => ({ success: true, data: { route: 'local' } }),
        }),
      ],
      pluginExecutionOverride: async (_name, _config, context) =>
        context.runId === 'remote-run' ? { success: true, data: { route: 'remote' } } : undefined,
    });
    const workflow = {
      id: 'route-workflow',
      name: 'Route workflow',
      steps: [{ id: 'step', name: 'Step', plugin: 'route-test', config: {} }],
    };
    const remote = await engine.runWorkflow('remote-run', workflow);
    const local = await engine.runWorkflow('local-run', workflow);
    assert.deepEqual(remote.results[0]?.pluginResult?.data, { route: 'remote' });
    assert.deepEqual(local.results[0]?.pluginResult?.data, { route: 'local' });
    await engine.destroy();
  });
});
