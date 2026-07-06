import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorkflowExecutor,
  RunAlreadyActiveError,
  type WorkflowDefinition,
  type PluginExecutor,
  type WorkflowLifecycleEvent,
} from '../executor/index.js';
import { createEngine } from '../engine/index.js';
import { createPlugin } from '@monai-devops/plugin-sdk';
import { SkipReasons, StepStatuses } from '../errors.js';
import { WorkflowEventTypes } from '../observer/event-types.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mockExecutor(impl?: PluginExecutor): PluginExecutor {
  return (
    impl ??
    (async (_name, _config, _ctx) => ({
      success: true,
      data: {},
    }))
  );
}

describe('executor run control', () => {
  it('rejects duplicate active workflowRunId', async () => {
    const executor = createWorkflowExecutor({
      pluginExecutor: async () => {
        await delay(100);
        return { success: true, data: {} };
      },
    });
    const workflow: WorkflowDefinition = {
      id: 'dup',
      name: 'dup',
      steps: [{ id: 'a', name: 'A', plugin: 'p', config: {} }],
    };

    const first = executor.executeWorkflow('dup-run', workflow);
    await assert.rejects(
      () => executor.executeWorkflow('dup-run', workflow),
      RunAlreadyActiveError,
    );
    await first;
  });

  it('cancelRun skips ready steps with user_cancelled and finishes cancelled', async () => {
    const events: WorkflowLifecycleEvent[] = [];
    const executor = createWorkflowExecutor({
      maxParallelSteps: 1,
      pluginExecutor: async () => {
        await delay(80);
        return { success: true, data: {} };
      },
      observer: {
        onEvent: async (e) => {
          events.push(e);
        },
      },
    });

    const workflow: WorkflowDefinition = {
      id: 'cancel-ready',
      name: 'cancel-ready',
      steps: [
        { id: 'a', name: 'A', plugin: 'p', config: {} },
        { id: 'b', name: 'B', plugin: 'p', config: {}, dependsOn: ['a'] },
        { id: 'c', name: 'C', plugin: 'p', config: {}, dependsOn: ['a'] },
      ],
    };

    const runPromise = executor.executeWorkflow('cancel-ready-run', workflow);
    await delay(10);
    const cancelResult = await executor.cancelRun('cancel-ready-run');
    assert.equal(cancelResult.currentStatus, 'cancelling');
    assert.equal(cancelResult.mode, 'best-effort');
    assert.ok((cancelResult.inFlightSteps ?? []).includes('a'));

    const run = await runPromise;
    assert.equal(run.status, 'cancelled');
    assert.equal(run.success, false);

    const b = run.results.find((r) => r.stepId === 'b');
    const c = run.results.find((r) => r.stepId === 'c');
    assert.equal(b?.skipReason, SkipReasons.USER_CANCELLED);
    assert.equal(c?.skipReason, SkipReasons.USER_CANCELLED);

    const types = events.map((e) => e.type);
    const cancelledIdx = types.indexOf(WorkflowEventTypes.WORKFLOW_CANCELLED);
    const finishedIdx = types.indexOf(WorkflowEventTypes.WORKFLOW_FINISHED);
    assert.ok(cancelledIdx >= 0);
    assert.ok(finishedIdx > cancelledIdx);
  });

  it('cancelRun is idempotent', async () => {
    const executor = createWorkflowExecutor({ pluginExecutor: mockExecutor() });
    const workflow: WorkflowDefinition = {
      id: 'idem',
      name: 'idem',
      steps: [{ id: 'a', name: 'A', plugin: 'p', config: {} }],
    };
    const run = await executor.executeWorkflow('idem-run', workflow);
    assert.equal(run.status, 'success');

    const second = await executor.cancelRun('idem-run');
    assert.equal(second.currentStatus, 'finished');
    const third = await executor.cancelRun('idem-run');
    assert.equal(third.currentStatus, 'finished');
  });

  it('user cancel stops scheduling remaining independent steps', async () => {
    const executor = createWorkflowExecutor({
      failFast: true,
      maxParallelSteps: 1,
      pluginExecutor: async () => {
        await delay(50);
        return { success: true, data: {} };
      },
    });

    const workflow: WorkflowDefinition = {
      id: 'cross',
      name: 'cross',
      steps: [
        { id: 'a', name: 'A', plugin: 'p', config: {} },
        { id: 'b', name: 'B', plugin: 'p', config: {} },
      ],
    };

    const runPromise = executor.executeWorkflow('cross-run', workflow);
    await delay(5);
    await executor.cancelRun('cross-run');
    const run = await runPromise;
    assert.equal(run.status, 'cancelled');
    const b = run.results.find((r) => r.stepId === 'b');
    assert.equal(b?.skipReason, SkipReasons.USER_CANCELLED);
  });

  it('getRunStatus reflects active and terminal runs', async () => {
    const executor = createWorkflowExecutor({
      pluginExecutor: async () => {
        await delay(50);
        return { success: true, data: {} };
      },
    });
    const workflow: WorkflowDefinition = {
      id: 'status',
      name: 'status',
      steps: [{ id: 'a', name: 'A', plugin: 'p', config: {} }],
    };

    const runPromise = executor.executeWorkflow('status-run', workflow);
    await delay(5);
    const active = executor.getRunStatus('status-run');
    assert.equal(active?.status, 'running');

    await runPromise;
    const done = executor.getRunStatus('status-run');
    assert.equal(done?.status, 'finished');
  });

  it('pauseRun and resumeRun continue DAG without duplicate execution', async () => {
    const executed: string[] = [];
    const events: WorkflowLifecycleEvent[] = [];
    const executor = createWorkflowExecutor({
      maxParallelSteps: 1,
      pluginExecutor: async (_n, _c, ctx) => {
        const stepId = (ctx as { stepId?: string }).stepId!;
        executed.push(stepId);
        if (stepId === 'a') await delay(80);
        else await delay(10);
        return { success: true, data: { stepId } };
      },
      observer: { onEvent: async (e) => events.push(e) },
    });

    const workflow: WorkflowDefinition = {
      id: 'pause',
      name: 'pause',
      steps: [
        { id: 'a', name: 'A', plugin: 'p', config: {} },
        { id: 'b', name: 'B', plugin: 'p', config: {}, dependsOn: ['a'] },
      ],
    };

    const runPromise = executor.executeWorkflow('pause-run', workflow);
    await delay(20);
    await executor.pauseRun('pause-run', { waitInFlight: true });
    await delay(20);
    await executor.resumeRun('pause-run');

    const run = await runPromise;
    assert.equal(run.status, 'success');
    assert.deepEqual(executed, ['a', 'b']);
    assert.ok(events.some((e) => e.type === WorkflowEventTypes.WORKFLOW_PAUSED));
    assert.ok(events.some((e) => e.type === WorkflowEventTypes.WORKFLOW_RESUMED));
  });

  it('destroyActiveRuns cancels active runs', async () => {
    const engine = createEngine({
      plugins: [
        createPlugin({
          name: 'slow',
          version: '1.0.0',
          execute: async () => {
            await delay(30);
            return { success: true, data: {} };
          },
        }),
      ],
    });

    const workflow: WorkflowDefinition = {
      id: 'destroy',
      name: 'destroy',
      steps: [
        { id: 'a', name: 'A', plugin: 'slow', config: {} },
        { id: 'b', name: 'B', plugin: 'slow', config: {}, dependsOn: ['a'] },
      ],
    };

    const runPromise = engine.runWorkflow('destroy-run', workflow);
    await delay(20);
    await engine.destroy();
    const run = await runPromise;
    assert.equal(run.status, 'cancelled');
    assert.equal(run.success, false);
  });

  it('engine cancelRun exposes best-effort mode', async () => {
    const engine = createEngine({
      plugins: [
        createPlugin({
          name: 'p',
          version: '1.0.0',
          execute: async () => {
            await delay(100);
            return { success: true, data: {} };
          },
        }),
      ],
    });

    const workflow: WorkflowDefinition = {
      id: 'eng-cancel',
      name: 'eng-cancel',
      steps: [
        { id: 'a', name: 'A', plugin: 'p', config: {} },
        { id: 'b', name: 'B', plugin: 'p', config: {}, dependsOn: ['a'] },
      ],
    };

    const runPromise = engine.runWorkflow('eng-cancel-run', workflow);
    await delay(10);
    const result = await engine.cancelRun('eng-cancel-run');
    assert.equal(result.mode, 'best-effort');
    assert.equal(result.currentStatus, 'cancelling');

    const run = await runPromise;
    assert.equal(run.status, 'cancelled');
    await engine.destroy();
  });

  it('hard cancel times out in-flight step after inFlightTimeoutMs', async () => {
    const executor = createWorkflowExecutor({
      inFlightTimeoutMs: 50,
      pluginExecutor: async () => {
        await delay(500);
        return { success: true, data: {} };
      },
    });

    const workflow: WorkflowDefinition = {
      id: 'hard',
      name: 'hard',
      steps: [{ id: 'a', name: 'A', plugin: 'p', config: {} }],
    };

    const runPromise = executor.executeWorkflow('hard-run', workflow);
    await delay(10);
    await executor.cancelRun('hard-run', { mode: 'hard' });
    const run = await runPromise;
    assert.equal(run.status, 'cancelled');
    const a = run.results.find((r) => r.stepId === 'a');
    assert.equal(a?.skipReason, SkipReasons.USER_CANCELLED);
  });

  it('failFast does not override user cancel skip reason', async () => {
    const executor = createWorkflowExecutor({
      failFast: true,
      maxParallelSteps: 1,
      pluginExecutor: async (_n, _c, ctx) => {
        const stepId = (ctx as { stepId?: string }).stepId!;
        if (stepId === 'a') {
          await delay(30);
          return { success: false, message: 'fail' };
        }
        await delay(10);
        return { success: true, data: {} };
      },
    });

    const workflow: WorkflowDefinition = {
      id: 'cross-fail',
      name: 'cross-fail',
      steps: [
        { id: 'a', name: 'A', plugin: 'p', config: {} },
        { id: 'b', name: 'B', plugin: 'p', config: {} },
      ],
    };

    const runPromise = executor.executeWorkflow('cross-fail-run', workflow);
    await delay(5);
    await executor.cancelRun('cross-fail-run');
    const run = await runPromise;
    assert.equal(run.status, 'cancelled');
    const b = run.results.find((r) => r.stepId === 'b');
    assert.equal(b?.skipReason, SkipReasons.USER_CANCELLED);
  });

  it('pauseRun emits workflow:paused only once when waitInFlight', async () => {
    const events: WorkflowLifecycleEvent[] = [];
    const executor = createWorkflowExecutor({
      maxParallelSteps: 1,
      pluginExecutor: async () => {
        await delay(80);
        return { success: true, data: {} };
      },
      observer: { onEvent: async (e) => events.push(e) },
    });

    const workflow: WorkflowDefinition = {
      id: 'pause-once',
      name: 'pause-once',
      steps: [
        { id: 'a', name: 'A', plugin: 'p', config: {} },
        { id: 'b', name: 'B', plugin: 'p', config: {}, dependsOn: ['a'] },
      ],
    };

    void executor.executeWorkflow('pause-once-run', workflow);
    await delay(10);
    await executor.pauseRun('pause-once-run', { waitInFlight: true });
    await delay(150);

    const pausedEvents = events.filter((e) => e.type === WorkflowEventTypes.WORKFLOW_PAUSED);
    assert.equal(pausedEvents.length, 1);
  });
});
