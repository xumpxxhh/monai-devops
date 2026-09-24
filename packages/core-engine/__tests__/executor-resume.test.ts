import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getContext } from '@monai-devops/plugin-sdk';
import { WorkflowContextKeys } from '../context-keys.js';
import { StepStatuses } from '../errors.js';
import {
  createWorkflowExecutor,
  WorkflowValidationError,
  type WorkflowDefinition,
  type WorkflowLifecycleEvent,
} from '../executor/index.js';

const workflow: WorkflowDefinition = {
  id: 'resume-workflow',
  name: 'Resume workflow',
  stateSchema: {
    type: 'object',
    properties: { count: { type: 'number' } },
    required: ['count'],
  },
  steps: [
    { id: 'a', name: 'A', plugin: 'test', config: {} },
    {
      id: 'b',
      name: 'B',
      plugin: 'test',
      config: {},
      dependsOn: ['a'],
      retryPolicy: { maxAttempts: 3, backoffMs: 0 },
    },
    { id: 'c', name: 'C', plugin: 'test', config: {}, dependsOn: ['b'] },
  ],
};

describe('executor checkpoint resume', () => {
  it('preserves completed output and state, then executes only pending steps with the next attempt', async () => {
    const calls: string[] = [];
    const events: WorkflowLifecycleEvent[] = [];
    const executor = createWorkflowExecutor({
      pluginExecutor: async (_name, _config, context) => {
        const stepId = getContext<string>(context, WorkflowContextKeys.stepId)!;
        calls.push(stepId);
        assert.deepEqual(getContext(context, WorkflowContextKeys.state), { count: 7 });
        if (stepId === 'b') {
          assert.deepEqual(getContext(context, WorkflowContextKeys.previousResultsData), {
            a: { stepId: 'a' },
          });
        }
        return { success: true, data: { stepId } };
      },
      observer: { onEvent: (event) => events.push(event) },
    });

    const run = await executor.executeWorkflow(
      'resume-run',
      workflow,
      {},
      {
        resume: {
          state: { count: 7 },
          completedResults: [
            {
              stepId: 'a',
              status: StepStatuses.COMPLETED,
              success: true,
              result: { stepId: 'a' },
              pluginResult: { success: true, data: { stepId: 'a' } },
            },
          ],
          nextAttemptByStep: { b: 1 },
        },
      },
    );

    assert.equal(run.success, true);
    assert.deepEqual(calls, ['b', 'c']);
    assert.deepEqual(
      run.results.map((result) => result.stepId),
      ['a', 'b', 'c'],
    );
    assert.deepEqual(run.state, { count: 7 });
    assert.equal(
      events.filter((event) => event.type === 'step:finished' && event.step.id === 'a').length,
      0,
    );
    const startedB = events.find((event) => event.type === 'step:start' && event.step.id === 'b');
    assert.equal(startedB?.execution?.attempt, 1);
  });

  it('rejects incomplete and exhausted snapshots before executing a plugin', async () => {
    let calls = 0;
    const executor = createWorkflowExecutor({
      pluginExecutor: async () => {
        calls += 1;
        return { success: true, data: {} };
      },
    });
    const completedB = { stepId: 'b', status: StepStatuses.COMPLETED, success: true };
    await assert.rejects(
      () =>
        executor.executeWorkflow(
          'bad-dependency',
          workflow,
          {},
          {
            resume: { state: { count: 1 }, completedResults: [completedB] },
          },
        ),
      WorkflowValidationError,
    );
    await assert.rejects(
      () =>
        executor.executeWorkflow(
          'missing-state',
          workflow,
          {},
          {
            resume: { completedResults: [] },
          },
        ),
      WorkflowValidationError,
    );
    await assert.rejects(
      () =>
        executor.executeWorkflow(
          'bad-attempt',
          workflow,
          {},
          {
            resume: { state: { count: 1 }, completedResults: [], nextAttemptByStep: { b: 3 } },
          },
        ),
      WorkflowValidationError,
    );
    assert.equal(calls, 0);
  });
});
