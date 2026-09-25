import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getContext } from '@monai-devops/plugin-sdk';
import { WorkflowContextKeys } from '../context-keys.js';
import { StepStatuses, SkipReasons } from '../errors.js';
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

  it('preserves a condition-skipped step and executes its unsettled descendants once', async () => {
    const calls: string[] = [];
    const events: WorkflowLifecycleEvent[] = [];
    const executor = createWorkflowExecutor({
      pluginExecutor: async (_name, _config, context) => {
        const stepId = getContext<string>(context, WorkflowContextKeys.stepId)!;
        calls.push(stepId);
        return { success: true, data: { stepId } };
      },
      observer: { onEvent: (event) => events.push(event) },
    });
    const definition: WorkflowDefinition = {
      id: 'skipped-branch',
      name: 'Skipped branch',
      steps: [
        { id: 'a', name: 'A', plugin: 'test', config: {} },
        {
          id: 'b',
          name: 'B',
          plugin: 'test',
          config: {},
          dependsOn: ['a'],
          condition: { when: 'enabled', equals: true },
        },
        { id: 'c', name: 'C', plugin: 'test', config: {}, dependsOn: ['b'] },
        { id: 'd', name: 'D', plugin: 'test', config: {}, dependsOn: ['a'] },
      ],
    };
    const run = await executor.executeWorkflow(
      'skipped-branch-run',
      definition,
      {},
      {
        resume: {
          completedResults: [
            {
              stepId: 'a',
              status: StepStatuses.COMPLETED,
              success: true,
              pluginResult: { success: true, data: { stepId: 'a' } },
            },
          ],
          skippedResults: [
            {
              stepId: 'b',
              status: StepStatuses.SKIPPED,
              success: true,
              skipReason: SkipReasons.CONDITION_NOT_MET,
            },
          ],
        },
      },
    );
    assert.equal(run.status, 'success');
    assert.deepEqual(calls.sort(), ['c', 'd']);
    assert.deepEqual(
      run.results.map((result) => result.status),
      [
        StepStatuses.COMPLETED,
        StepStatuses.SKIPPED,
        StepStatuses.COMPLETED,
        StepStatuses.COMPLETED,
      ],
    );
    assert.equal(
      events.filter((event) => event.type === 'step:finished' && event.step.id === 'b').length,
      0,
    );
    assert.equal(
      events.filter((event) => event.type === 'step:finished' && event.step.id === 'c').length,
      1,
    );
  });

  it('rejects a non-conditional skipped result', async () => {
    const executor = createWorkflowExecutor();
    await assert.rejects(
      () =>
        executor.executeWorkflow(
          'invalid-skipped-run',
          {
            id: 'invalid-skipped',
            name: 'Invalid skipped',
            steps: [{ id: 'a', name: 'A', plugin: 'test', config: {} }],
          },
          {},
          {
            resume: {
              completedResults: [],
              skippedResults: [
                {
                  stepId: 'a',
                  status: StepStatuses.SKIPPED,
                  success: true,
                  skipReason: SkipReasons.DEPENDENCY_FAILED,
                },
              ],
            },
          },
        ),
      WorkflowValidationError,
    );
  });
});
