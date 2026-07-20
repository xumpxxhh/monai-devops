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
      result: { success: true, workflowId: 'wf-1', results: [] },
    });
    expect(state.status).toBe('finished');
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
