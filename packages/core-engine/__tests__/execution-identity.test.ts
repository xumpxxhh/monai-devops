import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionIdentity } from '../executor/execution-identity.js';

test('createExecutionIdentity keeps job identity across attempts', () => {
  const first = createExecutionIdentity('run-1', 'build');
  const retry = createExecutionIdentity('run-1', 'build', 1);

  assert.deepEqual(first, {
    jobId: 'run-1/build',
    attemptId: 'run-1/build/attempt-0',
    attempt: 0,
  });
  assert.equal(retry.jobId, first.jobId);
  assert.equal(retry.attemptId, 'run-1/build/attempt-1');
  assert.equal(retry.attempt, 1);
});
