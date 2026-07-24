import { describe, expect, it } from 'vitest';
import { applyRunEvent, createInitialRunState, runStepsToFlow } from './run-state';

describe('run-state reducer', () => {
  const workflow = {
    id: 'wf-1',
    name: 'Test Workflow',
    steps: [{ id: 'step-1', name: 'Step 1', plugin: 'test-plugin', dependsOn: [] as string[] }],
  };

  it('creates initial state from workflow', () => {
    const state = createInitialRunState('run-1', workflow);
    expect(state.runId).toBe('run-1');
    expect(state.steps['step-1'].status).toBe('idle');
    expect(state.counts.total).toBe(1);
  });

  it('applies step lifecycle events', () => {
    let state = createInitialRunState('run-1', workflow);

    state = applyRunEvent(state, {
      type: 'workflow:start',
      meta: { workflowId: 'wf-1' },
      workflow,
    });

    state = applyRunEvent(state, {
      type: 'step:start',
      meta: { workflowId: 'wf-1' },
      step: { id: 'step-1', name: 'Step 1', plugin: 'test-plugin' },
    });
    expect(state.steps['step-1'].status).toBe('running');
    expect(state.counts.running).toBe(1);

    state = applyRunEvent(state, {
      type: 'plugin:log',
      meta: { workflowId: 'wf-1' },
      step: { id: 'step-1', name: 'Step 1', plugin: 'test-plugin' },
      log: { message: 'hello', level: 'info' },
    });
    expect(state.logs.some((l) => l.kind === 'log' && l.message === 'hello')).toBe(true);

    state = applyRunEvent(state, {
      type: 'plugin:log',
      meta: { workflowId: 'wf-1' },
      step: { id: 'step-1', name: 'Step 1', plugin: 'test-plugin' },
      log: { message: 'line1\n', level: 'info', stream: 'stdout' },
    });
    state = applyRunEvent(state, {
      type: 'plugin:log',
      meta: { workflowId: 'wf-1' },
      step: { id: 'step-1', name: 'Step 1', plugin: 'test-plugin' },
      log: { message: 'line2\n', level: 'info', stream: 'stdout' },
    });
    const streamLogs = state.logs.filter((l) => l.kind === 'stream');
    expect(streamLogs).toHaveLength(1);
    expect(streamLogs[0].message).toBe('line1\nline2\n');
    expect(streamLogs[0].stream).toBe('stdout');

    state = applyRunEvent(state, {
      type: 'step:finished',
      meta: { workflowId: 'wf-1' },
      step: { id: 'step-1', name: 'Step 1', plugin: 'test-plugin' },
      result: { status: 'completed', success: true, stepId: 'step-1' },
    });
    expect(state.steps['step-1'].status).toBe('completed');
    expect(state.counts.completed).toBe(1);

    state = applyRunEvent(state, {
      type: 'workflow:finished',
      meta: { workflowId: 'wf-1' },
      result: { success: true, status: 'success', workflowId: 'wf-1', results: [] },
    });
    expect(state.status).toBe('finished');
  });

  it('does not pollute top-level steps with parent-scoped events', () => {
    let state = createInitialRunState('parent-run', {
      id: 'wf-parent',
      name: 'Parent',
      steps: [
        { id: 'call-child', name: 'Call', kind: 'workflow', dependsOn: [] },
        { id: 'after', name: 'After', plugin: 'test-plugin', dependsOn: ['call-child'] },
      ],
    });

    state = applyRunEvent(state, {
      type: 'step:finished',
      workflowRunId: 'child-run',
      meta: { workflowId: 'wf-child' },
      parent: { runId: 'parent-run', stepId: 'call-child', iteration: 0 },
      step: { id: 'inner-step', name: 'Inner', plugin: 'test-plugin' },
      result: { status: 'completed', success: true, stepId: 'inner-step' },
    });

    expect(state.steps['inner-step']).toBeUndefined();
    expect(state.counts.total).toBe(2);
    expect(state.steps['call-child'].nestedLogs?.[0]?.length).toBeGreaterThan(0);

    const nestedLog = state.logs.find((l) => l.nesting?.parentStepId === 'call-child');
    expect(nestedLog?.nesting).toMatchObject({
      parentStepId: 'call-child',
      parentStepName: 'Call',
      iteration: 0,
    });
    expect(nestedLog?.message).not.toContain('[nested');
  });

  it('does not create orphan DAG nodes for nested step:queued missing parent', () => {
    let state = createInitialRunState('parent-run', {
      id: 'wf-parent',
      name: 'Parent',
      steps: [{ id: 'call-child', name: 'Call', kind: 'workflow', dependsOn: [] }],
    });

    state = applyRunEvent(state, {
      type: 'step:queued',
      workflowRunId: 'child-run-xyz',
      meta: { workflowId: 'wf-child' },
      step: { id: 'child-s1', name: '步骤 1', plugin: 'embedding-plugin' },
      resourceType: 'runner',
      priority: 0,
    });

    expect(state.steps['child-s1']).toBeUndefined();
    expect(state.counts.total).toBe(1);
    expect(state.steps['call-child'].status).toBe('idle');
    // 无 parent 字段时不强行造 nesting 分组，仅记普通日志
    expect(state.logs.some((l) => l.message === 'step:queued')).toBe(true);
    expect(state.logs.every((l) => !l.message.includes('[nested'))).toBe(true);
  });

  it('tracks workflow iteration start/finished on parent workflow step', () => {
    let state = createInitialRunState('parent-run', {
      id: 'wf-parent',
      name: 'Parent',
      steps: [{ id: 'call-child', name: 'Call', kind: 'workflow', dependsOn: [] }],
    });

    state = applyRunEvent(state, {
      type: 'workflow:iteration:start',
      workflowRunId: 'parent-run',
      meta: { workflowId: 'wf-parent' },
      step: { id: 'call-child', name: 'Call', kind: 'workflow' },
      iteration: 0,
    });
    expect(state.steps['call-child'].iterations?.[0]).toMatchObject({
      index: 0,
      status: 'running',
    });
    expect(state.counts.total).toBe(1);

    state = applyRunEvent(state, {
      type: 'workflow:iteration:finished',
      workflowRunId: 'parent-run',
      meta: { workflowId: 'wf-parent' },
      step: { id: 'call-child', name: 'Call', kind: 'workflow' },
      iteration: 0,
      childResult: {
        childRunId: 'child-run-0',
        success: true,
        status: 'success',
        state: { done: true },
      },
    });
    expect(state.steps['call-child'].iterations?.[0]).toMatchObject({
      index: 0,
      status: 'completed',
      childRunId: 'child-run-0',
      state: { done: true },
    });
  });

  it('converts steps and edges to flow data', () => {
    const state = createInitialRunState('run-1', {
      id: 'wf-1',
      name: 'DAG',
      steps: [
        { id: 'a', name: 'A', plugin: 'p1', dependsOn: [] },
        { id: 'b', name: 'B', plugin: 'p2', dependsOn: ['a'] },
      ],
    });
    const flow = runStepsToFlow(state.steps, state.edges);
    expect(flow.nodes).toHaveLength(2);
    expect(flow.edges).toHaveLength(1);
    expect(flow.edges[0]).toMatchObject({ source: 'a', target: 'b' });
    expect(flow.nodes.find((n) => n.id === 'b')?.data.status).toBe('idle');
  });
});
