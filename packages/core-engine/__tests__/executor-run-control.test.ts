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
import { createPlugin, sleep, throwIfAborted, type PluginContext } from '@monai-devops/plugin-sdk';
import { PluginContextKeys } from '@monai-devops/plugin-sdk';
import { SkipReasons, StepStatuses } from '../errors.js';
import { WorkflowEventTypes } from '../observer/event-types.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function getSignal(ctx: unknown): AbortSignal | undefined {
  return (ctx as Record<string, unknown>)[PluginContextKeys.signal] as AbortSignal | undefined;
}

const parallelWorkflow = (): WorkflowDefinition => ({
  id: 'parallel',
  name: 'parallel',
  steps: [
    { id: 'a', name: 'A', plugin: 'p', config: {} },
    { id: 'b', name: 'B', plugin: 'p', config: {} },
    { id: 'c', name: 'C', plugin: 'p', config: {}, dependsOn: ['a'] },
  ],
});

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
      observer: {
        onEvent: async (e) => {
          events.push(e);
        },
      },
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
      observer: {
        onEvent: async (e) => {
          events.push(e);
        },
      },
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

  it('parallel cancel keeps in-flight running and skips not-yet-started steps', async () => {
    const executed: string[] = [];
    const executor = createWorkflowExecutor({
      maxParallelSteps: 2,
      pluginExecutor: async (_n, _c, ctx) => {
        const stepId = (ctx as { stepId?: string }).stepId!;
        executed.push(stepId);
        await delay(80);
        return { success: true, data: { stepId } };
      },
    });

    const runPromise = executor.executeWorkflow('parallel-cancel-run', parallelWorkflow());
    await delay(15);
    await executor.cancelRun('parallel-cancel-run');
    const run = await runPromise;

    assert.equal(run.status, 'cancelled');
    assert.deepEqual(executed.sort(), ['a', 'b']);
    const c = run.results.find((r) => r.stepId === 'c');
    assert.equal(c?.skipReason, SkipReasons.USER_CANCELLED);
  });

  it('parallel pause and resume executes each started step once', async () => {
    const executed: string[] = [];
    const executor = createWorkflowExecutor({
      maxParallelSteps: 2,
      pluginExecutor: async (_n, _c, ctx) => {
        const stepId = (ctx as { stepId?: string }).stepId!;
        executed.push(stepId);
        await delay(60);
        return { success: true, data: { stepId } };
      },
    });

    const runPromise = executor.executeWorkflow('parallel-pause-run', {
      id: 'parallel-pause',
      name: 'parallel-pause',
      steps: [
        { id: 'a', name: 'A', plugin: 'p', config: {} },
        { id: 'b', name: 'B', plugin: 'p', config: {} },
      ],
    });
    await delay(15);
    await executor.pauseRun('parallel-pause-run', { waitInFlight: true });
    await delay(20);
    await executor.resumeRun('parallel-pause-run');

    const run = await runPromise;
    assert.equal(run.status, 'success');
    assert.deepEqual(executed.sort(), ['a', 'b']);
    assert.equal(new Set(executed).size, 2);
  });

  it('pauseRun blocks downstream step:start until resume', async () => {
    const events: WorkflowLifecycleEvent[] = [];
    const executor = createWorkflowExecutor({
      maxParallelSteps: 1,
      pluginExecutor: async (_n, _c, ctx) => {
        const stepId = (ctx as { stepId?: string }).stepId!;
        if (stepId === 'a') await delay(80);
        else await delay(10);
        return { success: true, data: { stepId } };
      },
      observer: {
        onEvent: async (e) => {
          events.push(e);
        },
      },
    });

    const workflow: WorkflowDefinition = {
      id: 'dep-pause',
      name: 'dep-pause',
      steps: [
        { id: 'a', name: 'A', plugin: 'p', config: {} },
        { id: 'b', name: 'B', plugin: 'p', config: {}, dependsOn: ['a'] },
      ],
    };

    const runPromise = executor.executeWorkflow('dep-pause-run', workflow);
    await delay(20);
    await executor.pauseRun('dep-pause-run', { waitInFlight: true });
    await delay(30);

    const bStartsWhilePaused = events.filter(
      (e) => e.type === WorkflowEventTypes.STEP_START && e.step.id === 'b',
    );
    assert.equal(bStartsWhilePaused.length, 0);

    await executor.resumeRun('dep-pause-run');
    const run = await runPromise;
    assert.equal(run.status, 'success');
    assert.ok(events.some((e) => e.type === WorkflowEventTypes.STEP_START && e.step.id === 'b'));
  });

  it('pauseRun abortInFlight cooperatively interrupts in-flight step and pauses run', async () => {
    const executor = createWorkflowExecutor({
      maxParallelSteps: 1,
      pluginExecutor: async (_n, _c, ctx) => {
        const signal = getSignal(ctx);
        await delay(30);
        if (signal?.aborted) {
          return { success: true, data: {} };
        }
        return new Promise<{ success: true; data: Record<string, never> }>((resolve) => {
          const onAbort = () => resolve({ success: true, data: {} });
          signal?.addEventListener('abort', onAbort, { once: true });
          setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve({ success: true, data: {} });
          }, 500);
        });
      },
    });

    const workflow: WorkflowDefinition = {
      id: 'pause-abort',
      name: 'pause-abort',
      steps: [
        { id: 'a', name: 'A', plugin: 'p', config: {} },
        { id: 'b', name: 'B', plugin: 'p', config: {}, dependsOn: ['a'] },
      ],
    };

    const runPromise = executor.executeWorkflow('pause-abort-run', workflow);
    await delay(10);
    await executor.pauseRun('pause-abort-run', { abortInFlight: true });
    assert.equal(executor.getRunStatus('pause-abort-run')?.status, 'paused');

    await executor.resumeRun('pause-abort-run');
    const run = await runPromise;
    assert.equal(run.status, 'success');
    const a = run.results.find((r) => r.stepId === 'a');
    assert.equal(a?.status, StepStatuses.COMPLETED);
  });

  it('hard cancel cooperatively exits in-flight plugin and finishes cancelled', async () => {
    const executor = createWorkflowExecutor({
      pluginExecutor: async (_n, _c, ctx) => {
        const signal = getSignal(ctx);
        await delay(30);
        if (signal?.aborted) {
          return { success: true, data: {} };
        }
        return new Promise<{ success: true; data: Record<string, never> }>((resolve) => {
          const onAbort = () => resolve({ success: true, data: {} });
          signal?.addEventListener('abort', onAbort, { once: true });
          setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve({ success: true, data: {} });
          }, 500);
        });
      },
    });

    const workflow: WorkflowDefinition = {
      id: 'hard-cooperate',
      name: 'hard-cooperate',
      steps: [{ id: 'a', name: 'A', plugin: 'p', config: {} }],
    };

    const runPromise = executor.executeWorkflow('hard-cooperate-run', workflow);
    await delay(10);
    await executor.cancelRun('hard-cooperate-run', { mode: 'hard' });
    const run = await runPromise;

    assert.equal(run.status, 'cancelled');
    const a = run.results.find((r) => r.stepId === 'a');
    assert.equal(a?.status, StepStatuses.COMPLETED);
  });

  it('pauseRun abortInFlight times out uncooperative in-flight step', async () => {
    const executor = createWorkflowExecutor({
      inFlightTimeoutMs: 50,
      pluginExecutor: async () => {
        await delay(500);
        return { success: true, data: {} };
      },
    });

    const workflow: WorkflowDefinition = {
      id: 'pause-abort-timeout',
      name: 'pause-abort-timeout',
      steps: [{ id: 'a', name: 'A', plugin: 'p', config: {} }],
    };

    const runPromise = executor.executeWorkflow('pause-abort-timeout-run', workflow);
    await delay(10);
    await executor.pauseRun('pause-abort-timeout-run', { abortInFlight: true });
    await delay(80);
    assert.equal(executor.getRunStatus('pause-abort-timeout-run')?.status, 'paused');
    await executor.resumeRun('pause-abort-timeout-run');
    const run = await runPromise;
    assert.equal(run.status, 'success');
    const a = run.results.find((r) => r.stepId === 'a');
    assert.equal(a?.skipReason, SkipReasons.PAUSE_INTERRUPTED);
  });

  it('hard cancel with throwIfAborted marks in-flight step as skipped', async () => {
    const executor = createWorkflowExecutor({
      pluginExecutor: async (_n, _c, ctx) => {
        await sleep(500, ctx as PluginContext);
        throwIfAborted(ctx as PluginContext);
        return { success: true, data: {} };
      },
    });

    const workflow: WorkflowDefinition = {
      id: 'coop-cancel',
      name: 'coop-cancel',
      steps: [{ id: 'a', name: 'A', plugin: 'p', config: {} }],
    };

    const runPromise = executor.executeWorkflow('coop-cancel-run', workflow);
    await delay(10);
    await executor.cancelRun('coop-cancel-run', { mode: 'hard' });
    const run = await runPromise;

    assert.equal(run.status, 'cancelled');
    const a = run.results.find((r) => r.stepId === 'a');
    assert.equal(a?.status, StepStatuses.SKIPPED);
    assert.equal(a?.skipReason, SkipReasons.USER_CANCELLED);
  });
});
