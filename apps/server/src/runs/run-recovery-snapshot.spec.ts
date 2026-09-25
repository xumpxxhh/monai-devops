import { AttemptStatuses, SkipReasons, StepStatuses } from '@monai-devops/core-engine';
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
      idempotencyKey: 'run-1/a',
      attempts: [{ attempt: 0, status: AttemptStatuses.SUCCEEDED }],
    },
    {
      stepId: 'b',
      status: AttemptStatuses.TIMED_OUT,
      idempotencyKey: 'run-1/b',
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

  it('accepts a safely paused Run without auto-starting it', () => {
    const run = runRecord();
    run.status = 'paused';
    const snapshot = buildRunRecoverySnapshot(run, [jobs()[0]!]);
    expect(snapshot.completedResults.map((result) => result.stepId)).toEqual(['a']);
    expect(snapshot.nextAttemptByStep).toEqual({});
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

    waiting[1]!.attempts[0]!.wakeReadyAt = new Date();
    waiting[1]!.checkpoint = {
      jobId: 'run-1/b',
      sourceAttemptId: 'run-1/b/attempt-0',
      version: 1,
      payload: { cursor: 3 },
      createdAt: new Date().toISOString(),
    };
    waiting[1]!.attempts[0]!.wakePayload = { signal: 'go' };
    expect(buildRunRecoverySnapshot(runRecord(), waiting).readyWaitsByStep).toEqual({
      b: { attempt: 0, checkpoint: waiting[1]!.checkpoint, wakePayload: { signal: 'go' } },
    });
    waiting[1]!.checkpoint = { ...waiting[1]!.checkpoint!, version: 0 };
    expect(() => buildRunRecoverySnapshot(runRecord(), waiting)).toThrow(/waiting checkpoint 无效/);

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
    retryable[1]!.attempts[0]!.reason = { code: 'internal', retryable: true };
    retryable[1]!.idempotencyKey = undefined;
    expect(() => buildRunRecoverySnapshot(runRecord(), retryable)).toThrow(/缺少重试幂等键/);
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

  it('rebuilds a condition-skipped branch while preserving pending independent work', () => {
    const run = runRecord();
    run.workflowSnapshot.steps[1]!.condition = { when: 'enabled', equals: true };
    run.counts.skipped = 1;
    run.events.push({
      type: 'step:finished',
      workflowRunId: run.runId,
      step: { id: 'b' },
      result: {
        stepId: 'b',
        status: StepStatuses.SKIPPED,
        success: true,
        skipReason: SkipReasons.CONDITION_NOT_MET,
      },
    });
    const persistedJobs = jobs();
    persistedJobs[1]!.status = AttemptStatuses.SKIPPED;
    persistedJobs[1]!.attempts[0]!.status = AttemptStatuses.SKIPPED;
    const snapshot = buildRunRecoverySnapshot(run, persistedJobs);
    expect(snapshot.skippedResults?.map((result) => result.stepId)).toEqual(['b']);
    expect(snapshot.nextAttemptByStep).toEqual({});
  });

  it('rejects missing or inconsistent skipped history', () => {
    const run = runRecord();
    run.counts.skipped = 1;
    expect(() => buildRunRecoverySnapshot(run, jobs())).toThrow(/跳过事件.*计数/);
    run.events.push({
      type: 'step:finished',
      workflowRunId: run.runId,
      step: { id: 'b' },
      result: {
        stepId: 'b',
        status: StepStatuses.SKIPPED,
        success: true,
        skipReason: SkipReasons.DEPENDENCY_FAILED,
      },
    });
    expect(() => buildRunRecoverySnapshot(run, jobs())).toThrow(/跳过事件.*不可安全续跑/);
  });
});
