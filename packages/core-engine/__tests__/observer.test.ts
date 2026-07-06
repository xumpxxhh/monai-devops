import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../engine/index.js';
import {
  assertValidWorkflowRunId,
  createWorkflowExecutor,
  WorkflowRunIdValidationError,
  WorkflowValidationError,
  type PluginExecutor,
} from '../executor/index.js';
import { createPlugin, getContext, getLogger } from '@monai-devops/plugin-sdk';
import { WorkflowContextKeys } from '../context-keys.js';
import { SkipReasons, StepStatuses } from '../errors.js';
import { WorkflowEventTypes, type WorkflowLifecycleEvent } from '../observer/index.js';

const TEST_RUN_ID = 'test-run-id';

const testPlugin = createPlugin({
  name: 'test-plugin',
  version: '1.0.0',
  execute: async (config) => {
    const type = config.type as string;
    if (type === 'unit') {
      return { success: true, message: 'ok', data: { type } };
    }
    if (type === 'fail') {
      return { success: false, message: 'plugin failed' };
    }
    return { success: false, message: `unknown: ${type}` };
  },
});

function mockExecutor(
  impl?: (stepId: string) => Promise<{ success: boolean; data?: unknown; message?: string }>,
): PluginExecutor {
  return async (_pluginName, _config, ctx) => {
    const stepId = getContext<string>(ctx, WorkflowContextKeys.stepId)!;
    if (impl) return impl(stepId);
    return { success: true, data: { stepId } };
  };
}

function collectEvents() {
  const events: WorkflowLifecycleEvent[] = [];
  const observer = {
    onEvent: async (event: WorkflowLifecycleEvent) => {
      events.push(event);
    },
  };
  return { events, observer };
}

describe('WorkflowObserver', () => {
  it('emits workflow and step events on single step success', async () => {
    const { events, observer } = collectEvents();
    const executor = createWorkflowExecutor({
      observer,
      pluginExecutor: mockExecutor(),
    });

    await executor.executeWorkflow(TEST_RUN_ID, {
      id: 'wf-1',
      name: 'single',
      steps: [{ id: 's1', name: 'S1', plugin: 'p', config: {} }],
    });

    assert.deepEqual(
      events.map((e) => e.type),
      [
        WorkflowEventTypes.WORKFLOW_START,
        WorkflowEventTypes.STEP_START,
        WorkflowEventTypes.STEP_FINISHED,
        WorkflowEventTypes.WORKFLOW_FINISHED,
      ],
    );
    assert.equal(
      events[0]?.type === WorkflowEventTypes.WORKFLOW_START && events[0].workflowRunId.length > 0,
      true,
    );
    const finished = events.find((e) => e.type === WorkflowEventTypes.STEP_FINISHED);
    assert.equal(
      finished?.type === WorkflowEventTypes.STEP_FINISHED && finished.result.status,
      StepStatuses.COMPLETED,
    );
  });

  it('uses workflowRunId first param and traceId from context', async () => {
    const { events, observer } = collectEvents();
    const executor = createWorkflowExecutor({
      observer,
      pluginExecutor: mockExecutor(),
    });

    await executor.executeWorkflow(
      'custom-run-id',
      {
        id: 'wf-meta',
        name: 'meta',
        steps: [{ id: 's1', name: 'S1', plugin: 'p', config: {} }],
      },
      { traceId: 'custom-trace-id' },
    );

    for (const event of events) {
      assert.equal(event.workflowRunId, 'custom-run-id');
      assert.equal(event.meta.traceId, 'custom-trace-id');
      assert.equal('runId' in event.meta, false);
    }
  });

  it('skips step:start for condition skip but emits step:finished', async () => {
    const { events, observer } = collectEvents();
    const executor = createWorkflowExecutor({
      observer,
      pluginExecutor: mockExecutor(),
    });

    await executor.executeWorkflow(TEST_RUN_ID, {
      id: 'wf-cond',
      name: 'cond',
      steps: [
        { id: 'a', name: 'A', plugin: 'p', config: {} },
        {
          id: 'b',
          name: 'B',
          plugin: 'p',
          config: {},
          dependsOn: ['a'],
          condition: { when: 'a', equals: { missing: true } },
        },
      ],
    });

    const stepStarts = events.filter((e) => e.type === WorkflowEventTypes.STEP_START);
    assert.equal(stepStarts.length, 1);
    assert.equal(
      stepStarts[0]?.type === WorkflowEventTypes.STEP_START && stepStarts[0].step.id,
      'a',
    );

    const bFinished = events.find(
      (e) => e.type === WorkflowEventTypes.STEP_FINISHED && e.step.id === 'b',
    );
    assert.equal(
      bFinished?.type === WorkflowEventTypes.STEP_FINISHED && bFinished.result.skipReason,
      SkipReasons.CONDITION_NOT_MET,
    );
  });

  it('emits step:finished failed on plugin failure', async () => {
    const { events, observer } = collectEvents();
    const executor = createWorkflowExecutor({
      observer,
      pluginExecutor: mockExecutor(async () => ({
        success: false,
        message: 'fail',
      })),
    });

    const run = await executor.executeWorkflow(TEST_RUN_ID, {
      id: 'wf-fail',
      name: 'fail',
      steps: [{ id: 's1', name: 'S1', plugin: 'p', config: {} }],
    });

    assert.equal(run.success, false);
    const stepFinished = events.find((e) => e.type === WorkflowEventTypes.STEP_FINISHED);
    assert.equal(
      stepFinished?.type === WorkflowEventTypes.STEP_FINISHED && stepFinished.result.status,
      StepStatuses.FAILED,
    );
    assert.equal(events.at(-1)?.type, WorkflowEventTypes.WORKFLOW_FINISHED);
  });

  it('failFast emits workflow_aborted for unscheduled steps', async () => {
    const { events, observer } = collectEvents();
    const executed: string[] = [];
    const executor = createWorkflowExecutor({
      observer,
      failFast: true,
      maxParallelSteps: 1,
      pluginExecutor: mockExecutor(async (stepId) => {
        executed.push(stepId);
        if (stepId === 'a') return { success: false, message: 'fail a' };
        return { success: true, data: {} };
      }),
    });

    await executor.executeWorkflow(TEST_RUN_ID, {
      id: 'wf-abort',
      name: 'abort',
      steps: [
        { id: 'a', name: 'A', plugin: 'p', config: {} },
        { id: 'b', name: 'B', plugin: 'p', config: {} },
        { id: 'c', name: 'C', plugin: 'p', config: {}, dependsOn: ['a'] },
      ],
    });

    assert.ok(executed.includes('a'));
    assert.ok(!executed.includes('b'));

    const bFinished = events.find(
      (e) => e.type === WorkflowEventTypes.STEP_FINISHED && e.step.id === 'b',
    );
    assert.equal(
      bFinished?.type === WorkflowEventTypes.STEP_FINISHED && bFinished.result.skipReason,
      SkipReasons.WORKFLOW_ABORTED,
    );

    const cFinished = events.find(
      (e) => e.type === WorkflowEventTypes.STEP_FINISHED && e.step.id === 'c',
    );
    assert.equal(
      cFinished?.type === WorkflowEventTypes.STEP_FINISHED && cFinished.result.skipReason,
      SkipReasons.DEPENDENCY_FAILED,
    );
  });

  it('parallel steps emit two step:finished events', async () => {
    const { events, observer } = collectEvents();
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const executor = createWorkflowExecutor({
      observer,
      maxParallelSteps: 2,
      pluginExecutor: async (_name, _config, ctx) => {
        const stepId = getContext<string>(ctx, WorkflowContextKeys.stepId)!;
        await delay(30);
        return { success: true, data: { stepId } };
      },
    });

    await executor.executeWorkflow(TEST_RUN_ID, {
      id: 'wf-par',
      name: 'parallel',
      steps: [
        { id: 'a', name: 'A', plugin: 'p', config: {} },
        { id: 'b', name: 'B', plugin: 'p', config: {} },
      ],
    });

    const finished = events.filter((e) => e.type === WorkflowEventTypes.STEP_FINISHED);
    assert.equal(finished.length, 2);
    const ids = finished.map((e) => (e.type === WorkflowEventTypes.STEP_FINISHED ? e.step.id : ''));
    assert.ok(ids.includes('a'));
    assert.ok(ids.includes('b'));
  });

  it('does not emit workflow:start on invalid DAG', async () => {
    const { events, observer } = collectEvents();
    const executor = createWorkflowExecutor({ observer, pluginExecutor: mockExecutor() });

    await assert.rejects(
      () =>
        executor.executeWorkflow(TEST_RUN_ID, {
          id: 'cycle',
          name: 'cycle',
          steps: [
            { id: 'a', name: 'A', plugin: 'p', config: {}, dependsOn: ['b'] },
            { id: 'b', name: 'B', plugin: 'p', config: {}, dependsOn: ['a'] },
          ],
        }),
      WorkflowValidationError,
    );

    assert.equal(events.length, 0);
  });

  it('does not emit workflow:start on invalid workflowRunId', async () => {
    const { events, observer } = collectEvents();
    const executor = createWorkflowExecutor({ observer, pluginExecutor: mockExecutor() });

    await assert.rejects(
      () =>
        executor.executeWorkflow('', {
          id: 'wf-invalid',
          name: 'invalid',
          steps: [{ id: 's1', name: 'S1', plugin: 'p', config: {} }],
        }),
      WorkflowRunIdValidationError,
    );

    assert.equal(events.length, 0);
  });

  it('createEngine observer receives step:queued then step:start on resource wait', async () => {
    const { events, observer } = collectEvents();
    const engine = createEngine({
      plugins: [testPlugin],
      observer,
      resources: { autoCleanup: false },
    });

    const runPromise = engine.runWorkflow('resource-run-id', {
      id: 'wf-res',
      name: 'resource queue',
      steps: [
        {
          id: 's1',
          name: 'needs runner',
          plugin: 'test-plugin',
          config: { type: 'unit', resourceType: 'runner' },
        },
      ],
    });

    await new Promise((r) => setTimeout(r, 20));
    assert.ok(events.some((e) => e.type === WorkflowEventTypes.WORKFLOW_START));
    assert.ok(events.some((e) => e.type === WorkflowEventTypes.STEP_QUEUED));

    engine.getResourceManager().registerResource({
      id: 'r1',
      type: 'runner',
      name: 'runner-1',
      status: 'available',
    });

    const run = await runPromise;
    assert.equal(run.success, true);

    const types = events.map((e) => e.type);
    const queuedIdx = types.indexOf(WorkflowEventTypes.STEP_QUEUED);
    const startIdx = types.indexOf(WorkflowEventTypes.STEP_START);
    const finishedIdx = types.indexOf(WorkflowEventTypes.STEP_FINISHED);
    assert.ok(queuedIdx >= 0 && startIdx > queuedIdx && finishedIdx > startIdx);
    assert.equal(events.at(-1)?.type, WorkflowEventTypes.WORKFLOW_FINISHED);
    for (const event of events) {
      assert.equal(event.workflowRunId, 'resource-run-id');
    }
    engine.destroy();
  });

  it('injects workflowRunId into step execution context as runId', async () => {
    let capturedRunId: string | undefined;
    const executor = createWorkflowExecutor({
      pluginExecutor: async (_name, _config, ctx) => {
        capturedRunId = getContext<string>(ctx, WorkflowContextKeys.runId);
        return { success: true, data: {} };
      },
    });

    await executor.executeWorkflow(
      'injected-run-id',
      {
        id: 'wf-ctx',
        name: 'ctx',
        steps: [{ id: 's1', name: 'S1', plugin: 'p', config: {} }],
      },
    );

    assert.equal(capturedRunId, 'injected-run-id');
  });

  it('executeStep alone does not emit workflow events', async () => {
    const { events, observer } = collectEvents();
    const executor = createWorkflowExecutor({ observer, pluginExecutor: mockExecutor() });

    await executor.executeStep(
      TEST_RUN_ID,
      { id: 'solo', name: 'Solo', plugin: 'p', config: {} },
      { workflowId: 'wf-solo', stepId: 'solo', runId: TEST_RUN_ID },
    );

    assert.equal(events.length, 0);
  });

  it('emits plugin:log between step:start and step:finished', async () => {
    const loggingPlugin = createPlugin({
      name: 'logging-plugin',
      version: '1.0.0',
      execute: async (config, context) => {
        getLogger(context).info('plugin started', { type: config.type });
        return { success: true, message: 'ok' };
      },
    });

    const { events, observer } = collectEvents();
    const engine = createEngine({
      plugins: [loggingPlugin],
      observer,
    });

    await engine.runWorkflow(TEST_RUN_ID, {
      id: 'wf-log',
      name: 'log',
      steps: [
        {
          id: 's1',
          name: 'S1',
          plugin: 'logging-plugin',
          config: { type: 'unit' },
        },
      ],
    });

    const types = events.map((e) => e.type);
    const startIdx = types.indexOf(WorkflowEventTypes.STEP_START);
    const finishedIdx = types.indexOf(WorkflowEventTypes.STEP_FINISHED);
    const logIdx = types.indexOf(WorkflowEventTypes.PLUGIN_LOG);

    assert.ok(startIdx >= 0 && logIdx > startIdx && finishedIdx > logIdx);

    const logEvent = events[logIdx];
    assert.equal(logEvent?.type, WorkflowEventTypes.PLUGIN_LOG);
    if (logEvent?.type === WorkflowEventTypes.PLUGIN_LOG) {
      assert.equal(logEvent.log.message, 'plugin started');
      assert.equal(logEvent.log.level, 'info');
      assert.equal(logEvent.step.id, 's1');
      assert.equal(logEvent.workflowRunId, TEST_RUN_ID);
      assert.deepEqual(logEvent.log.data, { type: 'unit' });
    }

    engine.destroy();
  });

  it('emits plugin:log with stream on append', async () => {
    const loggingPlugin = createPlugin({
      name: 'append-plugin',
      version: '1.0.0',
      execute: async (_config, context) => {
        getLogger(context).append('line1\n', 'stdout');
        return { success: true, message: 'ok' };
      },
    });

    const { events, observer } = collectEvents();
    const engine = createEngine({
      plugins: [loggingPlugin],
      observer,
    });

    await engine.runWorkflow(TEST_RUN_ID, {
      id: 'wf-append',
      name: 'append',
      steps: [{ id: 's1', name: 'S1', plugin: 'append-plugin', config: {} }],
    });

    const logEvent = events.find((e) => e.type === WorkflowEventTypes.PLUGIN_LOG);
    assert.equal(logEvent?.type, WorkflowEventTypes.PLUGIN_LOG);
    if (logEvent?.type === WorkflowEventTypes.PLUGIN_LOG) {
      assert.equal(logEvent.log.message, 'line1\n');
      assert.equal(logEvent.log.stream, 'stdout');
    }

    engine.destroy();
  });

  it('succeeds without observer when plugin uses getLogger', async () => {
    const loggingPlugin = createPlugin({
      name: 'noop-log-plugin',
      version: '1.0.0',
      execute: async (_config, context) => {
        getLogger(context).info('should not throw');
        return { success: true, message: 'ok' };
      },
    });

    const engine = createEngine({ plugins: [loggingPlugin] });

    const run = await engine.runWorkflow(TEST_RUN_ID, {
      id: 'wf-noop',
      name: 'noop',
      steps: [{ id: 's1', name: 'S1', plugin: 'noop-log-plugin', config: {} }],
    });

    assert.equal(run.success, true);
    engine.destroy();
  });

  it('preserves plugin:log order under concurrent log calls', async () => {
    const loggingPlugin = createPlugin({
      name: 'ordered-log-plugin',
      version: '1.0.0',
      execute: async (_config, context) => {
        const log = getLogger(context);
        log.info('first');
        log.info('second');
        log.append('third\n', 'stdout');
        return { success: true, message: 'ok' };
      },
    });

    const { events, observer } = collectEvents();
    const engine = createEngine({ plugins: [loggingPlugin], observer });

    await engine.runWorkflow(TEST_RUN_ID, {
      id: 'wf-order',
      name: 'order',
      steps: [{ id: 's1', name: 'S1', plugin: 'ordered-log-plugin', config: {} }],
    });

    const logMessages = events
      .filter(
        (e): e is Extract<WorkflowLifecycleEvent, { type: typeof WorkflowEventTypes.PLUGIN_LOG }> =>
          e.type === WorkflowEventTypes.PLUGIN_LOG,
      )
      .map((e) => e.log.message);

    assert.deepEqual(logMessages, ['first', 'second', 'third\n']);
    engine.destroy();
  });

  it('waits for slow plugin:log observer before step:finished', async () => {
    const events: WorkflowLifecycleEvent[] = [];
    let releaseSlowLog!: () => void;
    const slowLogGate = new Promise<void>((resolve) => {
      releaseSlowLog = resolve;
    });

    const loggingPlugin = createPlugin({
      name: 'slow-log-plugin',
      version: '1.0.0',
      execute: async (_config, context) => {
        getLogger(context).info('slow');
        getLogger(context).info('fast');
        return { success: true, message: 'ok' };
      },
    });

    const engine = createEngine({
      plugins: [loggingPlugin],
      observer: {
        onEvent: async (event) => {
          events.push(event);
          if (event.type === WorkflowEventTypes.PLUGIN_LOG && event.log.message === 'slow') {
            await slowLogGate;
          }
        },
      },
    });

    const runPromise = engine.runWorkflow(TEST_RUN_ID, {
      id: 'wf-slow-log',
      name: 'slow-log',
      steps: [{ id: 's1', name: 'S1', plugin: 'slow-log-plugin', config: {} }],
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      events.some((e) => e.type === WorkflowEventTypes.STEP_FINISHED),
      false,
      'step:finished must not emit before slow log completes',
    );

    releaseSlowLog();
    await runPromise;

    const types = events.map((e) => e.type);
    const slowIdx = events.findIndex(
      (e) => e.type === WorkflowEventTypes.PLUGIN_LOG && e.log.message === 'slow',
    );
    const fastIdx = events.findIndex(
      (e) => e.type === WorkflowEventTypes.PLUGIN_LOG && e.log.message === 'fast',
    );
    const finishedIdx = types.indexOf(WorkflowEventTypes.STEP_FINISHED);

    assert.ok(slowIdx >= 0 && fastIdx > slowIdx && finishedIdx > fastIdx);
    engine.destroy();
  });

  it('fails step when plugin:log observer throws', async () => {
    const loggingPlugin = createPlugin({
      name: 'throw-log-plugin',
      version: '1.0.0',
      execute: async (_config, context) => {
        getLogger(context).info('boom');
        return { success: true, message: 'ok' };
      },
    });

    const engine = createEngine({
      plugins: [loggingPlugin],
      observer: {
        onEvent: async (event) => {
          if (event.type === WorkflowEventTypes.PLUGIN_LOG) {
            throw new Error('log observer failed');
          }
        },
      },
    });

    const run = await engine.runWorkflow(TEST_RUN_ID, {
      id: 'wf-log-error',
      name: 'log-error',
      steps: [{ id: 's1', name: 'S1', plugin: 'throw-log-plugin', config: {} }],
    });

    assert.equal(run.success, false);
    assert.equal(run.results[0]?.status, StepStatuses.FAILED);
    engine.destroy();
  });
});

describe('assertValidWorkflowRunId', () => {
  it('accepts UUID and dry-run prefix ids', () => {
    assert.doesNotThrow(() => assertValidWorkflowRunId('550e8400-e29b-41d4-a716-446655440000'));
    assert.doesNotThrow(() => assertValidWorkflowRunId('dry-run-abc_123'));
  });

  it('rejects empty, whitespace, illegal chars, and overlong ids', () => {
    assert.throws(() => assertValidWorkflowRunId(''), WorkflowRunIdValidationError);
    assert.throws(() => assertValidWorkflowRunId('   '), WorkflowRunIdValidationError);
    assert.throws(() => assertValidWorkflowRunId('bad:id'), WorkflowRunIdValidationError);
    assert.throws(
      () => assertValidWorkflowRunId('a'.repeat(129)),
      WorkflowRunIdValidationError,
    );
  });
});
