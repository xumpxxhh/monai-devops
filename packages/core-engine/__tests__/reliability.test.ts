import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AttemptStatuses,
  assertAttemptTransition,
  canTransitionAttempt,
  isAttemptTerminal,
  validateReliableExecutionContract,
} from '../reliability/index.js';

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
});
