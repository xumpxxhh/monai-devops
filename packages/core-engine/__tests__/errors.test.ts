import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../engine/index.js';
import { createPluginManager } from '../plugin/index.js';
import { createWorkflowExecutor } from '../executor/index.js';
import { createPlugin, PluginFailureCodes } from '@monai-devops/plugin-sdk';
import { StepFailureKinds, StepStatuses } from '../errors.js';

describe('unified error model', () => {
  it('executePlugin returns PLUGIN_NOT_FOUND code', async () => {
    const plugins = createPluginManager();
    const result = await plugins.executePlugin('missing', {});

    assert.equal(result.success, false);
    assert.equal(result.code, PluginFailureCodes.PLUGIN_NOT_FOUND);
  });

  it('engine passes through plugin failure without throwing', async () => {
    const failingPlugin = createPlugin({
      name: 'fail',
      version: '1.0.0',
      execute: async () => ({
        success: false,
        message: 'business failure',
      }),
    });

    const engine = createEngine({ plugins: [failingPlugin] });
    const run = await engine.runWorkflow({
      id: 'wf-fail',
      name: 'fail',
      steps: [{ id: 's1', name: 'S1', plugin: 'fail', config: {} }],
    });

    assert.equal(run.success, false);
    const step = run.results[0];
    assert.equal(step?.status, StepStatuses.FAILED);
    assert.equal(step?.failureKind, StepFailureKinds.PLUGIN);
    assert.equal(step?.pluginResult?.message, 'business failure');
    engine.destroy();
  });

  it('custom pluginExecutor throw becomes internal failure', async () => {
    const executor = createWorkflowExecutor({
      pluginExecutor: async () => {
        throw new Error('unexpected throw');
      },
    });

    const run = await executor.executeWorkflow({
      id: 'wf-throw',
      name: 'throw',
      steps: [{ id: 's1', name: 'S1', plugin: 'p', config: {} }],
    });

    assert.equal(run.success, false);
    const step = run.results[0];
    assert.equal(step?.status, StepStatuses.FAILED);
    assert.equal(step?.failureKind, StepFailureKinds.INTERNAL);
    assert.equal(step?.error?.message, 'unexpected throw');
  });

  it('completed step has status completed', async () => {
    const okPlugin = createPlugin({
      name: 'ok',
      version: '1.0.0',
      execute: async () => ({ success: true, data: { ok: true } }),
    });

    const engine = createEngine({ plugins: [okPlugin] });
    const run = await engine.runWorkflow({
      id: 'wf-ok',
      name: 'ok',
      steps: [{ id: 's1', name: 'S1', plugin: 'ok', config: {} }],
    });

    assert.equal(run.success, true);
    assert.equal(run.results[0]?.status, StepStatuses.COMPLETED);
    engine.destroy();
  });
});
