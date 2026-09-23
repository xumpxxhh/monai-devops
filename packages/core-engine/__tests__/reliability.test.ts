import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AttemptStatuses,
  assertAttemptTransition,
  canTransitionAttempt,
  isAttemptTerminal,
  validateReliableExecutionContract,
  retryBackoffMs,
} from '../reliability/index.js';
import { createWorkflowExecutor, type WorkflowLifecycleEvent } from '../executor/index.js';
import { SkipReasons } from '../errors.js';

describe('reliable execution contract', () => {
  it('accepts the lease and execution lifecycle', () => {
    assert.equal(canTransitionAttempt(AttemptStatuses.QUEUED, AttemptStatuses.LEASED), true);
    assert.equal(canTransitionAttempt(AttemptStatuses.LEASED, AttemptStatuses.RUNNING), true);
    assert.equal(canTransitionAttempt(AttemptStatuses.RUNNING, AttemptStatuses.WAITING), true);
    assert.equal(canTransitionAttempt(AttemptStatuses.WAITING, AttemptStatuses.LEASED), true);
    assert.equal(canTransitionAttempt(AttemptStatuses.RUNNING, AttemptStatuses.SUCCEEDED), true);
    assert.equal(canTransitionAttempt(AttemptStatuses.QUEUED, AttemptStatuses.SKIPPED), true);
  });

  it('rejects transitions out of terminal states', () => {
    assert.equal(isAttemptTerminal(AttemptStatuses.FAILED), true);
    assert.equal(isAttemptTerminal(AttemptStatuses.SKIPPED), true);
    assert.throws(
      () => assertAttemptTransition(AttemptStatuses.FAILED, AttemptStatuses.QUEUED),
      /Invalid attempt transition/,
    );
  });

  it('requires idempotency and a valid retry policy', () => {
    const base = {
      execution: { jobId: 'run/s1', attemptId: 'run/s1/attempt-0', attempt: 0 },
      idempotencyKey: 'run/s1',
      retryPolicy: { maxAttempts: 3, backoffMs: 100 },
    };
    assert.doesNotThrow(() => validateReliableExecutionContract(base));
    assert.throws(() => validateReliableExecutionContract({ ...base, idempotencyKey: ' ' }));
    assert.throws(() =>
      validateReliableExecutionContract({
        ...base,
        retryPolicy: { maxAttempts: 0, backoffMs: 100 },
      }),
    );
  });

  it('caps exponential retry backoff', () => {
    const policy = { maxAttempts: 5, backoffMs: 100, maxBackoffMs: 250 };
    assert.equal(retryBackoffMs(policy, 0), 100);
    assert.equal(retryBackoffMs(policy, 1), 200);
    assert.equal(retryBackoffMs(policy, 2), 250);
  });

  it('creates a new attempt for a retryable failure and preserves event history', async () => {
    let calls = 0;
    const events: WorkflowLifecycleEvent[] = [];
    const executor = createWorkflowExecutor({
      pluginExecutor: async () => {
        calls += 1;
        if (calls === 1) throw new Error('transient executor failure');
        return { success: true, data: { calls } };
      },
      observer: { onEvent: (event) => events.push(event) },
    });

    const run = await executor.executeWorkflow('retry-run', {
      id: 'retry-workflow',
      name: 'Retry workflow',
      steps: [
        {
          id: 'retry-step',
          name: 'Retry step',
          plugin: 'transient',
          config: {},
          retryPolicy: { maxAttempts: 2, backoffMs: 0 },
        },
      ],
    });

    const finished = events.filter((event) => event.type === 'step:finished');
    assert.equal(calls, 2);
    assert.equal(run.success, true);
    assert.equal(finished.length, 2);
    assert.equal(finished[0]?.execution?.attempt, 0);
    assert.equal(finished[1]?.execution?.attempt, 1);
    assert.equal(run.results[0]?.execution?.attempt, 1);
  });

  it('does not retry non-retryable business failures', async () => {
    let calls = 0;
    const executor = createWorkflowExecutor({
      pluginExecutor: async () => {
        calls += 1;
        return { success: false, message: 'business rejected' };
      },
    });

    const run = await executor.executeWorkflow('no-retry-run', {
      id: 'no-retry-workflow',
      name: 'No retry workflow',
      steps: [
        {
          id: 'step',
          name: 'Step',
          plugin: 'business',
          config: {},
          retryPolicy: { maxAttempts: 3, backoffMs: 0 },
        },
      ],
    });

    assert.equal(calls, 1);
    assert.equal(run.success, false);
  });

  it('rejects an invalid step retry policy before execution', async () => {
    const executor = createWorkflowExecutor({
      pluginExecutor: async () => ({ success: true }),
    });

    await assert.rejects(
      executor.executeWorkflow('invalid-retry-run', {
        id: 'invalid-retry-workflow',
        name: 'Invalid retry workflow',
        steps: [
          {
            id: 'step',
            name: 'Step',
            plugin: 'plugin',
            config: {},
            retryPolicy: { maxAttempts: 0, backoffMs: 0 },
          },
        ],
      }),
      /retryPolicy\.maxAttempts/,
    );
  });

  it('cancels during backoff without invoking the next attempt', async () => {
    let calls = 0;
    let releaseFirstFailure!: () => void;
    const firstFailure = new Promise<void>((resolve) => {
      releaseFirstFailure = resolve;
    });
    const events: WorkflowLifecycleEvent[] = [];
    const executor = createWorkflowExecutor({
      pluginExecutor: async () => {
        calls += 1;
        throw new Error('transient');
      },
      observer: {
        onEvent: (event) => {
          events.push(event);
          if (event.type === 'step:finished' && event.execution?.attempt === 0) {
            releaseFirstFailure();
          }
        },
      },
    });
    const runPromise = executor.executeWorkflow('cancel-backoff-run', {
      id: 'cancel-backoff-workflow',
      name: 'Cancel backoff workflow',
      steps: [
        {
          id: 'step',
          name: 'Step',
          plugin: 'plugin',
          config: {},
          retryPolicy: { maxAttempts: 3, backoffMs: 30 },
        },
      ],
    });

    await firstFailure;
    await executor.cancelRun('cancel-backoff-run');
    const run = await runPromise;
    const finished = events.filter(
      (event): event is Extract<WorkflowLifecycleEvent, { type: 'step:finished' }> =>
        event.type === 'step:finished',
    );

    assert.equal(calls, 1);
    assert.equal(run.status, 'cancelled');
    assert.equal(finished.length, 2);
    assert.equal(finished[1]?.execution?.attempt, 1);
    assert.equal(finished[1]?.result.skipReason, SkipReasons.USER_CANCELLED);
  });
});
