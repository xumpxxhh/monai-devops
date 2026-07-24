import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorkflowExecutor,
  deriveChildRunId,
  jsonSchemaToZod,
  shortHash,
  validateDag,
  validateStepKinds,
  validateWorkflowNesting,
  WorkflowValidationError,
  type PluginExecutor,
  type ResolveWorkflow,
  type WorkflowDefinition,
  type WorkflowLifecycleEvent,
} from '../executor/index.js';
import { StepFailureKinds, StepStatuses } from '../errors.js';
import { WorkflowEventTypes } from '../observer/index.js';

const TEST_RUN_ID = 'parent-run-001';
const WORKFLOW_RUN_ID_MAX_LENGTH = 128;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const mockExecutor: PluginExecutor = async (pluginName) => ({
  success: true,
  data: { plugin: pluginName },
});

describe('stateSchema / set_state', () => {
  it('returns state when stateSchema declared and set_state merges', async () => {
    const executor = createWorkflowExecutor({ pluginExecutor: mockExecutor });
    const workflow: WorkflowDefinition = {
      id: 'with-state',
      name: 'with-state',
      stateSchema: {
        type: 'object',
        properties: {
          count: { type: 'number' },
          label: { type: 'string' },
        },
        required: ['count'],
      },
      steps: [
        {
          id: 'init',
          name: 'init',
          kind: 'set_state',
          patch: { count: 1, label: 'a' },
        },
        {
          id: 'bump',
          name: 'bump',
          kind: 'set_state',
          patch: { count: 2 },
          dependsOn: ['init'],
        },
      ],
    };

    const run = await executor.executeWorkflow(
      TEST_RUN_ID,
      workflow,
      {},
      { initialState: { count: 0 } },
    );
    assert.equal(run.success, true);
    assert.deepEqual(run.state, { count: 2, label: 'a' });
    assert.equal(run.results[0]?.status, StepStatuses.COMPLETED);
    assert.deepEqual(run.results[0]?.pluginResult?.data, { count: 1, label: 'a' });
  });

  it('rejects set_state when stateSchema missing', async () => {
    const executor = createWorkflowExecutor({ pluginExecutor: mockExecutor });
    const workflow: WorkflowDefinition = {
      id: 'no-state',
      name: 'no-state',
      steps: [{ id: 's', name: 's', kind: 'set_state', patch: { x: 1 } }],
    };
    await assert.rejects(
      () => executor.executeWorkflow(TEST_RUN_ID, workflow),
      WorkflowValidationError,
    );
  });

  it('rejects initialState when stateSchema missing', async () => {
    const executor = createWorkflowExecutor({ pluginExecutor: mockExecutor });
    const workflow: WorkflowDefinition = {
      id: 'pure',
      name: 'pure',
      steps: [{ id: 'a', name: 'A', plugin: 'p', config: {} }],
    };
    await assert.rejects(
      () => executor.executeWorkflow(TEST_RUN_ID, workflow, {}, { initialState: { x: 1 } }),
      WorkflowValidationError,
    );
  });

  it('does not include state field when no stateSchema', async () => {
    const executor = createWorkflowExecutor({ pluginExecutor: mockExecutor });
    const workflow: WorkflowDefinition = {
      id: 'pure',
      name: 'pure',
      steps: [{ id: 'a', name: 'A', plugin: 'p', config: {} }],
    };
    const run = await executor.executeWorkflow(TEST_RUN_ID, workflow);
    assert.equal(run.success, true);
    assert.equal('state' in run, false);
  });

  it('fails set_state when merged state violates schema', async () => {
    const executor = createWorkflowExecutor({ pluginExecutor: mockExecutor });
    const workflow: WorkflowDefinition = {
      id: 'strict',
      name: 'strict',
      stateSchema: {
        type: 'object',
        properties: { count: { type: 'number' } },
        required: ['count'],
      },
      steps: [
        {
          id: 'bad',
          name: 'bad',
          kind: 'set_state',
          patch: { count: 'not-a-number' },
        },
      ],
    };
    const run = await executor.executeWorkflow(
      TEST_RUN_ID,
      workflow,
      {},
      { initialState: { count: 0 } },
    );
    assert.equal(run.success, false);
    assert.equal(run.results[0]?.status, StepStatuses.FAILED);
  });
});

describe('workflow ref step (single + loop)', () => {
  it('runs child once via resolveWorkflow(importId) and returns aggregated data', async () => {
    const child: WorkflowDefinition = {
      id: 'child',
      name: 'child',
      stateSchema: {
        type: 'object',
        properties: { value: { type: 'number' } },
        required: ['value'],
      },
      steps: [
        {
          id: 'write',
          name: 'write',
          kind: 'set_state',
          patch: { value: 42 },
        },
      ],
    };

    const resolveWorkflow: ResolveWorkflow = async (importId) => {
      assert.equal(importId, 'imp-1');
      return child;
    };

    const executor = createWorkflowExecutor({
      pluginExecutor: mockExecutor,
      resolveWorkflow,
    });

    const parent: WorkflowDefinition = {
      id: 'parent',
      name: 'parent',
      steps: [
        {
          id: 'call',
          name: 'call',
          kind: 'workflow',
          workflowRef: { importId: 'imp-1' },
          inputState: { value: 0 },
        },
      ],
    };

    const run = await executor.executeWorkflow('parent-run-wf', parent);
    assert.equal(run.success, true);
    const data = run.results[0]?.pluginResult?.data as {
      state: { value: number };
      iterationCount: number;
    };
    assert.equal(data.state.value, 42);
    assert.equal(data.iterationCount, 1);
  });

  it('loops until condition then stops', async () => {
    const simpleChild: WorkflowDefinition = {
      id: 'c',
      name: 'c',
      stateSchema: {
        type: 'object',
        properties: { done: { type: 'boolean' } },
        required: ['done'],
      },
      steps: [{ id: 's', name: 's', kind: 'set_state', patch: { done: true } }],
    };

    const executor = createWorkflowExecutor({
      pluginExecutor: mockExecutor,
      resolveWorkflow: async () => simpleChild,
    });

    const parent: WorkflowDefinition = {
      id: 'p',
      name: 'p',
      steps: [
        {
          id: 'call',
          name: 'call',
          kind: 'workflow',
          workflowRef: { importId: 'x' },
          inputState: { done: false },
          loop: { maxIterations: 5, until: { when: 'done', equals: true } },
        },
      ],
    };

    const run = await executor.executeWorkflow('loop-run', parent);
    assert.equal(run.success, true);
    const data = run.results[0]?.pluginResult?.data as { iterationCount: number };
    assert.equal(data.iterationCount, 1);
  });

  it('stops at maxIterations when until never met', async () => {
    const child: WorkflowDefinition = {
      id: 'c',
      name: 'c',
      stateSchema: {
        type: 'object',
        properties: { done: { type: 'boolean' } },
        required: ['done'],
      },
      steps: [{ id: 's', name: 's', kind: 'set_state', patch: { done: false } }],
    };

    let resolveCount = 0;
    const executor = createWorkflowExecutor({
      pluginExecutor: mockExecutor,
      resolveWorkflow: async () => {
        resolveCount++;
        return child;
      },
    });

    const parent: WorkflowDefinition = {
      id: 'p',
      name: 'p',
      steps: [
        {
          id: 'call',
          name: 'call',
          kind: 'workflow',
          workflowRef: { importId: 'x' },
          inputState: { done: false },
          loop: { maxIterations: 3, until: { when: 'done', equals: true } },
        },
      ],
    };

    const run = await executor.executeWorkflow('max-iter-run', parent);
    assert.equal(run.success, true);
    const data = run.results[0]?.pluginResult?.data as { iterationCount: number };
    assert.equal(data.iterationCount, 3);
    assert.equal(resolveCount, 3);
  });

  it('marks SUBWORKFLOW_FAILED when child fails', async () => {
    const child: WorkflowDefinition = {
      id: 'c',
      name: 'c',
      steps: [{ id: 'a', name: 'A', plugin: 'p', config: {} }],
    };

    const executor = createWorkflowExecutor({
      pluginExecutor: async () => ({ success: false, message: 'boom' }),
      resolveWorkflow: async () => child,
    });

    const parent: WorkflowDefinition = {
      id: 'p',
      name: 'p',
      steps: [
        {
          id: 'call',
          name: 'call',
          kind: 'workflow',
          workflowRef: { importId: 'x' },
        },
      ],
    };

    const run = await executor.executeWorkflow('fail-child', parent);
    assert.equal(run.success, false);
    assert.equal(run.results[0]?.failureKind, StepFailureKinds.SUBWORKFLOW_FAILED);
  });

  it('fails when resolveWorkflow missing', async () => {
    const executor = createWorkflowExecutor({ pluginExecutor: mockExecutor });
    const parent: WorkflowDefinition = {
      id: 'p',
      name: 'p',
      steps: [
        {
          id: 'call',
          name: 'call',
          kind: 'workflow',
          workflowRef: { importId: 'x' },
        },
      ],
    };
    const run = await executor.executeWorkflow('no-resolve', parent);
    assert.equal(run.success, false);
    assert.equal(run.results[0]?.status, StepStatuses.FAILED);
  });

  it('allows downstream $ref to workflow step aggregated data', async () => {
    const child: WorkflowDefinition = {
      id: 'c',
      name: 'c',
      stateSchema: {
        type: 'object',
        properties: { v: { type: 'number' } },
        required: ['v'],
      },
      steps: [{ id: 's', name: 's', kind: 'set_state', patch: { v: 7 } }],
    };

    let seenConfig: unknown;
    const executor = createWorkflowExecutor({
      pluginExecutor: async (_n, config) => {
        seenConfig = config;
        return { success: true, data: {} };
      },
      resolveWorkflow: async () => child,
    });

    const parent: WorkflowDefinition = {
      id: 'p',
      name: 'p',
      steps: [
        {
          id: 'call',
          name: 'call',
          kind: 'workflow',
          workflowRef: { importId: 'x' },
          inputState: { v: 0 },
        },
        {
          id: 'use',
          name: 'use',
          plugin: 'p',
          config: {
            fromChild: { $ref: { fromStepId: 'call', path: ['state', 'v'] } },
          },
          dependsOn: ['call'],
        },
      ],
    };

    const run = await executor.executeWorkflow('ref-agg', parent);
    assert.equal(run.success, true);
    assert.deepEqual(seenConfig, { fromChild: 7 });
  });
});

describe('backward compat / helpers', () => {
  it('treats steps without kind as plugin', async () => {
    const executor = createWorkflowExecutor({ pluginExecutor: mockExecutor });
    const workflow: WorkflowDefinition = {
      id: 'legacy',
      name: 'legacy',
      steps: [{ id: 'a', name: 'A', plugin: 'p', config: {} }],
    };
    const run = await executor.executeWorkflow(TEST_RUN_ID, workflow);
    assert.equal(run.success, true);
  });

  it('validateDag is exported and detects cycles', () => {
    assert.throws(
      () =>
        validateDag([
          { id: 'a', name: 'A', plugin: 'p', config: {}, dependsOn: ['b'] },
          { id: 'b', name: 'B', plugin: 'p', config: {}, dependsOn: ['a'] },
        ]),
      WorkflowValidationError,
    );
  });

  it('validateStepKinds rejects invalid stateSchema', () => {
    assert.throws(
      () =>
        validateStepKinds({
          id: 'w',
          name: 'w',
          stateSchema: { type: 'not-a-real-type' },
          steps: [],
        }),
      WorkflowValidationError,
    );
  });

  it('deriveChildRunId stays within length and charset', () => {
    const id = deriveChildRunId('parent-run-abcdefghijklmnop', 'step-id-verylongname', 0);
    assert.ok(id.length < 128);
    assert.match(id, /^[A-Za-z0-9_-]+$/);
    assert.ok(id.includes('__iter0'));
  });

  it('shortHash differs for different full inputs with same prefix', () => {
    const a = shortHash('aaaaaaaaaaaaXXX:step');
    const b = shortHash('aaaaaaaaaaaaYYY:step');
    assert.notEqual(a, b);
  });

  it('jsonSchemaToZod converts basic object schema', () => {
    const zod = jsonSchemaToZod({
      type: 'object',
      properties: { x: { type: 'string' } },
      required: ['x'],
    });
    assert.equal(zod.safeParse({ x: 'ok' }).success, true);
    assert.equal(zod.safeParse({}).success, false);
  });
});

describe('validateWorkflowNesting', () => {
  it('rejects loop nested inside loop when resolveWorkflow provided', async () => {
    const innerMost: WorkflowDefinition = {
      id: 'leaf',
      name: 'leaf',
      steps: [{ id: 'a', name: 'A', plugin: 'p', config: {} }],
    };
    const midWithLoop: WorkflowDefinition = {
      id: 'mid',
      name: 'mid',
      steps: [
        {
          id: 'call-leaf',
          name: 'call-leaf',
          kind: 'workflow',
          workflowRef: { importId: 'imp-leaf' },
          loop: { maxIterations: 2 },
        },
      ],
    };
    const parent: WorkflowDefinition = {
      id: 'parent',
      name: 'parent',
      steps: [
        {
          id: 'call-mid',
          name: 'call-mid',
          kind: 'workflow',
          workflowRef: { importId: 'imp-mid' },
          loop: { maxIterations: 3 },
        },
      ],
    };

    const catalog = new Map<string, WorkflowDefinition>([
      ['imp-mid', midWithLoop],
      ['imp-leaf', innerMost],
    ]);

    await assert.rejects(
      () =>
        validateWorkflowNesting(parent, {
          resolveWorkflow: async (id) => {
            const def = catalog.get(id);
            if (!def) throw new Error(`missing ${id}`);
            return def;
          },
        }),
      (err: unknown) =>
        err instanceof WorkflowValidationError && err.message.includes('禁止循环嵌套循环'),
    );
  });

  it('rejects reference cycles', async () => {
    const a: WorkflowDefinition = {
      id: 'wf-a',
      name: 'a',
      steps: [
        {
          id: 'to-b',
          name: 'to-b',
          kind: 'workflow',
          workflowRef: { importId: 'imp-b' },
        },
      ],
    };
    const b: WorkflowDefinition = {
      id: 'wf-b',
      name: 'b',
      steps: [
        {
          id: 'to-a',
          name: 'to-a',
          kind: 'workflow',
          workflowRef: { importId: 'imp-a' },
        },
      ],
    };
    const catalog = new Map<string, WorkflowDefinition>([
      ['imp-a', a],
      ['imp-b', b],
    ]);

    await assert.rejects(
      () =>
        validateWorkflowNesting(a, {
          resolveWorkflow: async (id) => catalog.get(id)!,
        }),
      (err: unknown) => err instanceof WorkflowValidationError && err.message.includes('引用环'),
    );
  });

  it('rejects nesting deeper than maxNestingDepth', async () => {
    const leaf: WorkflowDefinition = {
      id: 'd3',
      name: 'd3',
      steps: [{ id: 'a', name: 'A', plugin: 'p', config: {} }],
    };
    const d2: WorkflowDefinition = {
      id: 'd2',
      name: 'd2',
      steps: [{ id: 'c', name: 'c', kind: 'workflow', workflowRef: { importId: 'imp-d3' } }],
    };
    const d1: WorkflowDefinition = {
      id: 'd1',
      name: 'd1',
      steps: [{ id: 'c', name: 'c', kind: 'workflow', workflowRef: { importId: 'imp-d2' } }],
    };
    const root: WorkflowDefinition = {
      id: 'd0',
      name: 'd0',
      steps: [{ id: 'c', name: 'c', kind: 'workflow', workflowRef: { importId: 'imp-d1' } }],
    };
    const catalog = new Map([
      ['imp-d1', d1],
      ['imp-d2', d2],
      ['imp-d3', leaf],
    ]);

    await assert.rejects(
      () =>
        validateWorkflowNesting(root, {
          maxNestingDepth: 2,
          resolveWorkflow: async (id) => catalog.get(id)!,
        }),
      WorkflowValidationError,
    );
  });
});

describe('nesting runtime / cascade', () => {
  it('deriveChildRunId stays within length across 3 nesting levels', () => {
    let runId = 'top-level-run01';
    for (let depth = 0; depth < 3; depth++) {
      runId = deriveChildRunId(runId, `step-level-${depth}-longname`, depth);
      assert.ok(
        runId.length <= WORKFLOW_RUN_ID_MAX_LENGTH,
        `depth ${depth} length ${runId.length}`,
      );
      assert.match(runId, /^[A-Za-z0-9_-]+$/);
    }
  });

  it('rejects loop-in-loop at runtime', async () => {
    const leaf: WorkflowDefinition = {
      id: 'leaf',
      name: 'leaf',
      steps: [{ id: 'a', name: 'A', plugin: 'p', config: {} }],
    };
    const mid: WorkflowDefinition = {
      id: 'mid',
      name: 'mid',
      steps: [
        {
          id: 'inner',
          name: 'inner',
          kind: 'workflow',
          workflowRef: { importId: 'imp-leaf' },
          loop: { maxIterations: 2 },
        },
      ],
    };
    const parent: WorkflowDefinition = {
      id: 'parent',
      name: 'parent',
      steps: [
        {
          id: 'outer',
          name: 'outer',
          kind: 'workflow',
          workflowRef: { importId: 'imp-mid' },
          loop: { maxIterations: 2 },
        },
      ],
    };
    const catalog = new Map([
      ['imp-mid', mid],
      ['imp-leaf', leaf],
    ]);

    const executor = createWorkflowExecutor({
      pluginExecutor: mockExecutor,
      resolveWorkflow: async (id) => catalog.get(id)!,
    });

    const run = await executor.executeWorkflow('loop-nest-run', parent);
    assert.equal(run.success, false);
    assert.equal(run.results[0]?.status, StepStatuses.FAILED);
    assert.match(String(run.results[0]?.error?.message ?? ''), /禁止循环嵌套循环/);
  });

  it('cascades pause and resume to active child run', async () => {
    let childEntered = false;
    let afterRan = false;
    let releaseChild: (() => void) | undefined;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });

    const child: WorkflowDefinition = {
      id: 'child',
      name: 'child',
      steps: [
        { id: 'slow', name: 'slow', plugin: 'slow', config: {} },
        {
          id: 'after',
          name: 'after',
          plugin: 'after',
          config: {},
          dependsOn: ['slow'],
        },
      ],
    };
    const parent: WorkflowDefinition = {
      id: 'parent',
      name: 'parent',
      steps: [
        {
          id: 'call',
          name: 'call',
          kind: 'workflow',
          workflowRef: { importId: 'imp-child' },
        },
      ],
    };

    const executor = createWorkflowExecutor({
      maxParallelSteps: 1,
      pluginExecutor: async (_n, _c, ctx) => {
        const stepId = (ctx as { stepId?: string }).stepId;
        if (stepId === 'slow') {
          childEntered = true;
          await childGate;
        }
        if (stepId === 'after') {
          afterRan = true;
        }
        return { success: true, data: {} };
      },
      resolveWorkflow: async () => child,
    });

    const parentRunId = 'cascade-pause-parent';
    const childRunId = deriveChildRunId(parentRunId, 'call', 0);
    const runPromise = executor.executeWorkflow(parentRunId, parent);

    for (let i = 0; i < 50 && !childEntered; i++) await delay(10);
    assert.equal(childEntered, true);

    const pausePromise = executor.pauseRun(parentRunId, { waitInFlight: true });
    await delay(20);
    releaseChild?.();
    await pausePromise;

    assert.equal(executor.getRunStatus(parentRunId)?.status, 'paused');
    assert.equal(executor.getRunStatus(childRunId)?.status, 'paused');
    assert.equal(afterRan, false);

    await executor.resumeRun(parentRunId);
    const run = await runPromise;
    assert.equal(run.success, true);
    assert.equal(afterRan, true);
  });

  it('cascades cancel to active child run', async () => {
    let childEntered = false;
    const child: WorkflowDefinition = {
      id: 'child',
      name: 'child',
      steps: [{ id: 'slow', name: 'slow', plugin: 'slow', config: {} }],
    };
    const parent: WorkflowDefinition = {
      id: 'parent',
      name: 'parent',
      steps: [
        {
          id: 'call',
          name: 'call',
          kind: 'workflow',
          workflowRef: { importId: 'imp-child' },
        },
      ],
    };

    const executor = createWorkflowExecutor({
      pluginExecutor: async (_n, _c, ctx) => {
        childEntered = true;
        const signal = ctx.signal;
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) {
            reject(new Error('aborted'));
            return;
          }
          const t = setTimeout(resolve, 5000);
          signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('aborted'));
          });
        });
        return { success: true, data: {} };
      },
      resolveWorkflow: async () => child,
    });

    const parentRunId = 'cascade-cancel-parent';
    const childRunId = deriveChildRunId(parentRunId, 'call', 0);
    const runPromise = executor.executeWorkflow(parentRunId, parent);

    for (let i = 0; i < 50 && !childEntered; i++) await delay(10);
    assert.equal(childEntered, true);

    await executor.cancelRun(parentRunId, { mode: 'hard' });
    const run = await runPromise;
    assert.equal(run.status, 'cancelled');
    // 子 run 应已结束（不再活跃）
    const childStatus = executor.getRunStatus(childRunId)?.status;
    assert.ok(childStatus === 'cancelled' || childStatus === undefined || childStatus === 'failed');
  });
});

describe('observability: parent + iteration events', () => {
  it('injects parent on child events and emits iteration boundaries for loop', async () => {
    const child: WorkflowDefinition = {
      id: 'c',
      name: 'c',
      stateSchema: {
        type: 'object',
        properties: { n: { type: 'number' } },
        required: ['n'],
      },
      steps: [{ id: 'bump', name: 'bump', kind: 'set_state', patch: { n: 1 } }],
    };

    const events: WorkflowLifecycleEvent[] = [];
    const parentRunId = 'obs-loop-parent';
    const executor = createWorkflowExecutor({
      pluginExecutor: mockExecutor,
      resolveWorkflow: async () => child,
      observer: {
        onEvent: async (e) => {
          events.push(e);
        },
      },
    });

    const parent: WorkflowDefinition = {
      id: 'p',
      name: 'p',
      steps: [
        {
          id: 'call',
          name: 'call',
          kind: 'workflow',
          workflowRef: { importId: 'x' },
          inputState: { n: 0 },
          loop: { maxIterations: 3, until: { when: 'n', equals: 99 } },
        },
      ],
    };

    const run = await executor.executeWorkflow(parentRunId, parent);
    assert.equal(run.success, true);

    const iterStarts = events.filter((e) => e.type === WorkflowEventTypes.WORKFLOW_ITERATION_START);
    const iterFinished = events.filter(
      (e) => e.type === WorkflowEventTypes.WORKFLOW_ITERATION_FINISHED,
    );
    assert.equal(iterStarts.length, 3);
    assert.equal(iterFinished.length, 3);

    for (let i = 0; i < 3; i++) {
      const start = iterStarts[i]!;
      assert.equal(start.workflowRunId, parentRunId);
      assert.equal(start.iteration, i);
      assert.equal(start.step.id, 'call');
      assert.equal(start.parent, undefined);

      const finished = iterFinished[i]!;
      assert.equal(finished.workflowRunId, parentRunId);
      assert.equal(finished.iteration, i);
      assert.equal(finished.childResult.success, true);
      assert.equal(finished.childResult.status, 'success');
      assert.equal(finished.childResult.childRunId, deriveChildRunId(parentRunId, 'call', i));
    }

    const childStarts = events.filter(
      (e) => e.type === WorkflowEventTypes.WORKFLOW_START && e.workflowRunId !== parentRunId,
    );
    assert.equal(childStarts.length, 3);
    for (const e of childStarts) {
      assert.ok(e.parent);
      assert.equal(e.parent.runId, parentRunId);
      assert.equal(e.parent.stepId, 'call');
      assert.ok(e.parent.iteration >= 0 && e.parent.iteration < 3);
    }

    const childSteps = events.filter(
      (e) =>
        e.type === WorkflowEventTypes.STEP_FINISHED &&
        e.workflowRunId !== parentRunId &&
        e.step.id === 'bump',
    );
    assert.equal(childSteps.length, 3);
    for (const e of childSteps) {
      assert.ok(e.parent);
      assert.equal(e.parent.runId, parentRunId);
      assert.equal(e.parent.stepId, 'call');
    }

    // 父顶层事件不应带 parent
    const parentStart = events.find(
      (e) => e.type === WorkflowEventTypes.WORKFLOW_START && e.workflowRunId === parentRunId,
    );
    assert.ok(parentStart);
    assert.equal(parentStart.parent, undefined);

    const parentCallFinished = events.find(
      (e) =>
        e.type === WorkflowEventTypes.STEP_FINISHED &&
        e.workflowRunId === parentRunId &&
        e.step.id === 'call',
    );
    assert.ok(parentCallFinished);
    assert.equal(parentCallFinished.parent, undefined);
  });

  it('emits single iteration pair for non-loop workflow step', async () => {
    const child: WorkflowDefinition = {
      id: 'c',
      name: 'c',
      steps: [{ id: 'noop', name: 'noop', plugin: 'echo', config: {} }],
    };

    const events: WorkflowLifecycleEvent[] = [];
    const parentRunId = 'obs-once-parent';
    const executor = createWorkflowExecutor({
      pluginExecutor: mockExecutor,
      resolveWorkflow: async () => child,
      observer: {
        onEvent: async (e) => {
          events.push(e);
        },
      },
    });

    await executor.executeWorkflow(parentRunId, {
      id: 'p',
      name: 'p',
      steps: [
        {
          id: 'call',
          name: 'call',
          kind: 'workflow',
          workflowRef: { importId: 'x' },
        },
      ],
    });

    const starts = events.filter((e) => e.type === WorkflowEventTypes.WORKFLOW_ITERATION_START);
    const finished = events.filter(
      (e) => e.type === WorkflowEventTypes.WORKFLOW_ITERATION_FINISHED,
    );
    assert.equal(starts.length, 1);
    assert.equal(finished.length, 1);
    assert.equal(starts[0]!.iteration, 0);
    assert.equal(finished[0]!.childResult.childRunId, deriveChildRunId(parentRunId, 'call', 0));
  });
});
