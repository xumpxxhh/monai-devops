import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getContext, PluginContextKeys } from '@monai-devops/plugin-sdk';
import { WorkflowSuspendedError } from '../errors.js';
import {
  createWorkflowExecutor,
  type WorkflowDefinition,
  type WorkflowLifecycleEvent,
} from '../executor/index.js';

describe('durable plugin wait', () => {
  it('suspends without finishing the step, then resumes the same Attempt before downstream work', async () => {
    const calls: string[] = [];
    const events: WorkflowLifecycleEvent[] = [];
    const checkpoints: unknown[] = [];
    let first = true;
    const executor = createWorkflowExecutor({
      maxParallelSteps: 2,
      pluginExecutor: async (_name, _config, context) => {
        const stepId = context.stepId as string;
        calls.push(stepId);
        if (stepId === 'wait' && first) {
          first = false;
          return {
            success: true,
            wait: {
              checkpoint: { cursor: 'saved' },
              condition: { kind: 'signal' as const, key: 'continue' },
            },
          };
        }
        if (stepId === 'wait') {
          assert.deepEqual(getContext(context, PluginContextKeys.checkpoint), { cursor: 'saved' });
          assert.deepEqual(getContext(context, PluginContextKeys.wakePayload), { approved: true });
          assert.deepEqual(context.execution, {
            jobId: 'wait-run/wait',
            attemptId: 'wait-run/wait/attempt-0',
            attempt: 0,
          });
        }
        return { success: true, data: { stepId } };
      },
      onStepWait: async (_step, _context, checkpoint) => {
        checkpoints.push(checkpoint);
      },
      observer: { onEvent: (event) => events.push(event) },
    });
    const workflow: WorkflowDefinition = {
      id: 'wait-workflow',
      name: 'Wait workflow',
      steps: [
        { id: 'wait', name: 'Wait', plugin: 'test', config: {}, mayWait: true },
        { id: 'next', name: 'Next', plugin: 'test', config: {} },
      ],
    };
    await assert.rejects(
      () => executor.executeWorkflow('wait-run', workflow),
      WorkflowSuspendedError,
    );
    assert.deepEqual(calls, ['wait']);
    assert.equal(events.filter((event) => event.type === 'step:finished').length, 0);
    assert.equal(events.filter((event) => event.type === 'workflow:finished').length, 0);
    assert.deepEqual(checkpoints, [
      {
        jobId: 'wait-run/wait',
        sourceAttemptId: 'wait-run/wait/attempt-0',
        version: 1,
        payload: { cursor: 'saved' },
        createdAt: (checkpoints[0] as { createdAt: string }).createdAt,
      },
    ]);

    const resumed = await executor.executeWorkflow(
      'wait-run',
      workflow,
      {},
      {
        resume: {
          completedResults: [],
          readyWaitsByStep: {
            wait: {
              attempt: 0,
              checkpoint: checkpoints[0] as never,
              wakePayload: { approved: true },
            },
          },
        },
      },
    );
    assert.equal(resumed.status, 'success');
    assert.deepEqual(calls, ['wait', 'wait', 'next']);
    assert.equal(
      events.filter((event) => event.type === 'step:finished' && event.step.id === 'wait').length,
      1,
    );
  });

  it('increments the checkpoint version when the same Attempt waits again', async () => {
    const checkpoints: Array<{
      version: number;
      payload: unknown;
      jobId: string;
      sourceAttemptId: string;
      createdAt: string;
    }> = [];
    let calls = 0;
    const executor = createWorkflowExecutor({
      pluginExecutor: async () => {
        calls += 1;
        return calls <= 2
          ? {
              success: true,
              wait: {
                checkpoint: { stage: calls },
                condition: {
                  kind: 'timer' as const,
                  wakeAt: new Date(Date.now() + 1_000).toISOString(),
                },
              },
            }
          : { success: true, data: { done: true } };
      },
      onStepWait: async (_step, _context, checkpoint) => {
        checkpoints.push(checkpoint);
      },
    });
    const workflow: WorkflowDefinition = {
      id: 'repeat-wait',
      name: 'Repeat wait',
      steps: [{ id: 'wait', name: 'Wait', plugin: 'test', config: {}, mayWait: true }],
    };
    await assert.rejects(
      () => executor.executeWorkflow('repeat-wait-run', workflow),
      WorkflowSuspendedError,
    );
    await assert.rejects(
      () =>
        executor.executeWorkflow(
          'repeat-wait-run',
          workflow,
          {},
          {
            resume: {
              completedResults: [],
              readyWaitsByStep: {
                wait: { attempt: 0, checkpoint: checkpoints[0]! },
              },
            },
          },
        ),
      WorkflowSuspendedError,
    );
    assert.deepEqual(
      checkpoints.map((checkpoint) => checkpoint.version),
      [1, 2],
    );
    const result = await executor.executeWorkflow(
      'repeat-wait-run',
      workflow,
      {},
      {
        resume: {
          completedResults: [],
          readyWaitsByStep: {
            wait: { attempt: 0, checkpoint: checkpoints[1]! },
          },
        },
      },
    );
    assert.equal(result.status, 'success');
    assert.equal(calls, 3);
  });
});
