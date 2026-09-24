import { AttemptStatuses, StepStatuses } from '@monai-devops/core-engine';
import type { RecoveryJob } from '../execution/execution.repository.js';
import { buildRunRecoverySnapshot, RunRecoveryNotReadyError } from './run-recovery-snapshot.js';
import type { RunRecord } from './runs.repository.js';

function runRecord(): RunRecord {
  return {
    runId: 'run-1',
    workflowId: 'workflow-1',
    workflowSnapshot: {
      id: 'workflow-1',
      name: 'Recovery',
      stateSchema: {
        type: 'object',
        properties: { count: { type: 'number' } },
        required: ['count'],
      },
      steps: [
        { id: 'a', name: 'State', kind: 'set_state', patch: { count: 7 } },
        {
          id: 'b',
          name: 'Retry',
          plugin: 'test',
          config: {},
          dependsOn: ['a'],
          retryPolicy: { maxAttempts: 2, backoffMs: 0 },
        },
        { id: 'c', name: 'Last', plugin: 'test', config: {}, dependsOn: ['b'] },
      ],
    },
    status: 'running',
    counts: { total: 3, completed: 1, failed: 0, skipped: 0 },
    createdAt: new Date('2026-09-24T00:00:00Z'),
    metadata: {},
    events: [
      {
        type: 'step:finished',
        workflowRunId: 'run-1',
        step: { id: 'a' },
        result: {
          stepId: 'a',
          status: StepStatuses.COMPLETED,
          success: true,
          result: { count: 7 },
          pluginResult: { success: true, data: { count: 7 } },
        },
      },
    ],
  };
}

function jobs(): RecoveryJob[] {
  return [
    {
      stepId: 'a',
      status: AttemptStatuses.SUCCEEDED,
      attempts: [{ attempt: 0, status: AttemptStatuses.SUCCEEDED }],
    },
    {
      stepId: 'b',
      status: AttemptStatuses.TIMED_OUT,
      attempts: [{ attempt: 0, status: AttemptStatuses.TIMED_OUT }],
    },
  ];
}

describe('buildRunRecoverySnapshot', () => {
  it('rebuilds completed output, state and the next attempt from persisted records', () => {
    const snapshot = buildRunRecoverySnapshot(runRecord(), jobs());
    expect(snapshot.completedResults.map((result) => result.stepId)).toEqual(['a']);
    expect(snapshot.state).toEqual({ count: 7 });
    expect(snapshot.nextAttemptByStep).toEqual({ b: 1 });
  });

  it('rejects event history that was trimmed below the completed count', () => {
    const run = runRecord();
    run.events = [];
    expect(() => buildRunRecoverySnapshot(run, jobs())).toThrow(RunRecoveryNotReadyError);
  });

  it('rejects waiting attempts and exhausted retries', () => {
    const waiting = jobs();
    waiting[1]!.status = AttemptStatuses.WAITING;
    waiting[1]!.attempts[0]!.status = AttemptStatuses.WAITING;
    expect(() => buildRunRecoverySnapshot(runRecord(), waiting)).toThrow(/waiting/);

    const exhausted = jobs();
    exhausted[1]!.attempts.push({ attempt: 1, status: AttemptStatuses.TIMED_OUT });
    expect(() => buildRunRecoverySnapshot(runRecord(), exhausted)).toThrow(/无可用重试/);
  });

  it('only retries a failed Attempt when its persisted reason is retryable', () => {
    const retryable = jobs();
    retryable[1]!.status = AttemptStatuses.QUEUED;
    retryable[1]!.attempts[0] = {
      attempt: 0,
      status: AttemptStatuses.FAILED,
      reason: { code: 'internal', retryable: true },
    };
    expect(buildRunRecoverySnapshot(runRecord(), retryable).nextAttemptByStep).toEqual({ b: 1 });

    retryable[1]!.attempts[0]!.reason = { code: 'business', retryable: false };
    expect(() => buildRunRecoverySnapshot(runRecord(), retryable)).toThrow(/无可用重试/);
  });

  it('requires a completed set_state event for workflows with state', () => {
    const run = runRecord();
    run.counts.completed = 0;
    run.events = [];
    expect(() => buildRunRecoverySnapshot(run, [])).toThrow(/缺少可恢复 state/);
    expect(buildRunRecoverySnapshot(run, [], { present: true, value: { count: 0 } }).state).toEqual(
      { count: 0 },
    );
  });
});
