import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorkflowExecutor,
  WorkflowValidationError,
  type WorkflowDefinition,
  type PluginExecutor,
} from '../executor/index.js';
import { getContext, type PluginResult } from '@monai-devops/plugin-sdk';
import { WorkflowContextKeys } from '../context-keys.js';
import { SkipReasons, StepFailureKinds, StepStatuses } from '../errors.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mockExecutor(
  impl?: (plugin: string, stepId: string) => Promise<PluginResult>,
): PluginExecutor {
  return async (pluginName, _config, ctx) => {
    const stepId = getContext<string>(ctx, WorkflowContextKeys.stepId)!;
    if (impl) return impl(pluginName, stepId);
    return { success: true, data: { plugin: pluginName, stepId } };
  };
}

describe('executor DAG', () => {
  it('detects cycle', async () => {
    const executor = createWorkflowExecutor({ pluginExecutor: mockExecutor() });
    const workflow: WorkflowDefinition = {
      id: 'cycle',
      name: 'cycle',
      steps: [
        { id: 'a', name: 'A', plugin: 'p', config: {}, dependsOn: ['b'] },
        { id: 'b', name: 'B', plugin: 'p', config: {}, dependsOn: ['a'] },
      ],
    };
    await assert.rejects(() => executor.executeWorkflow(workflow), WorkflowValidationError);
  });

  it('runs independent steps in parallel', async () => {
    const startOrder: string[] = [];
    const endOrder: string[] = [];

    const executor = createWorkflowExecutor({
      maxParallelSteps: 2,
      pluginExecutor: async (_name, _config, ctx) => {
        const stepId = getContext<string>(ctx, WorkflowContextKeys.stepId)!;
        startOrder.push(stepId);
        await delay(50);
        endOrder.push(stepId);
        return { success: true, data: { stepId } };
      },
    });

    const workflow: WorkflowDefinition = {
      id: 'parallel',
      name: 'parallel',
      steps: [
        { id: 'a', name: 'A', plugin: 'p', config: {} },
        { id: 'b', name: 'B', plugin: 'p', config: {} },
        { id: 'c', name: 'C', plugin: 'p', config: {}, dependsOn: ['a', 'b'] },
      ],
    };

    const run = await executor.executeWorkflow(workflow);
    assert.equal(run.success, true);
    assert.equal(startOrder.length, 3);
    assert.ok(
      startOrder.indexOf('a') < 2 && startOrder.indexOf('b') < 2,
      'a and b should start before c finishes',
    );
    assert.ok(endOrder.indexOf('c') === 2, 'c should finish last');
  });

  it('failFast stops scheduling new steps', async () => {
    const executed: string[] = [];
    const executor = createWorkflowExecutor({
      failFast: true,
      maxParallelSteps: 2,
      pluginExecutor: async (_name, _config, ctx) => {
        const stepId = getContext<string>(ctx, WorkflowContextKeys.stepId)!;
        executed.push(stepId);
        if (stepId === 'a') return { success: false, message: 'fail a' };
        return { success: true, data: {} };
      },
    });

    const workflow: WorkflowDefinition = {
      id: 'failfast',
      name: 'failfast',
      steps: [
        { id: 'a', name: 'A', plugin: 'p', config: {} },
        { id: 'b', name: 'B', plugin: 'p', config: {} },
        { id: 'c', name: 'C', plugin: 'p', config: {}, dependsOn: ['a'] },
      ],
    };

    const run = await executor.executeWorkflow(workflow);
    assert.equal(run.success, false);
    const a = run.results.find((r) => r.stepId === 'a');
    assert.equal(a?.status, StepStatuses.FAILED);
    assert.equal(a?.failureKind, StepFailureKinds.PLUGIN);
    assert.ok(executed.includes('a'));
    assert.ok(!executed.includes('c'));
  });

  it('skips downstream when failFast is false', async () => {
    const executor = createWorkflowExecutor({
      failFast: false,
      pluginExecutor: async (_name, _config, ctx) => {
        if (getContext<string>(ctx, WorkflowContextKeys.stepId) === 'a')
          return { success: false, message: 'fail' };
        return { success: true, data: {} };
      },
    });

    const workflow: WorkflowDefinition = {
      id: 'nofailfast',
      name: 'nofailfast',
      steps: [
        { id: 'a', name: 'A', plugin: 'p', config: {} },
        { id: 'b', name: 'B', plugin: 'p', config: {}, dependsOn: ['a'] },
      ],
    };

    const run = await executor.executeWorkflow(workflow);
    const b = run.results.find((r) => r.stepId === 'b');
    assert.equal(b?.status, StepStatuses.SKIPPED);
    assert.equal(b?.success, true);
    assert.deepEqual(b?.result, {
      skipped: true,
      reason: SkipReasons.DEPENDENCY_FAILED,
    });
  });

  it('evaluates structured condition', async () => {
    const executed: string[] = [];
    const executor = createWorkflowExecutor({
      pluginExecutor: async (_name, _config, ctx) => {
        executed.push(getContext<string>(ctx, WorkflowContextKeys.stepId)!);
        return { success: true, data: { ok: true } };
      },
    });

    const workflow: WorkflowDefinition = {
      id: 'cond',
      name: 'cond',
      steps: [
        {
          id: 'a',
          name: 'A',
          plugin: 'p',
          config: {},
        },
        {
          id: 'b',
          name: 'B',
          plugin: 'p',
          config: {},
          dependsOn: ['a'],
          condition: { when: 'a', equals: { ok: false } },
        },
      ],
    };

    const run = await executor.executeWorkflow(workflow);
    assert.equal(executed.length, 1);
    const b = run.results.find((r) => r.stepId === 'b');
    assert.equal(b?.status, StepStatuses.SKIPPED);
    assert.deepEqual(b?.result, {
      skipped: true,
      reason: SkipReasons.CONDITION_NOT_MET,
    });
  });
});
