import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'node:test';
import {
  EXECUTOR_DATA_MAX_BYTES,
  EXECUTOR_EVENT_MAX_BYTES,
  EXECUTOR_PROTOCOL_VERSION,
  assessExecutorCancel,
  assessExecutorMessage,
  isExecutorObjectRef,
  validateExecutorDispatch,
  type ExecutorDispatchV1,
  type ExecutorFenceState,
  type ExecutorMessageV1,
} from '../executor/adapter-contract.js';

const NOW = new Date('2026-09-25T10:00:00.000Z');

it('accepts only bounded opaque result references', () => {
  const ref = {
    version: 1,
    objectId: '12345678-1234-1234-1234-123456789abc',
    kind: 'result',
    contentType: 'application/json',
    sizeBytes: 70_000,
    sha256: 'a'.repeat(64),
    expiresAt: '2026-10-01T00:00:00.000Z',
  };
  assert.equal(isExecutorObjectRef(ref), true);
  assert.equal(isExecutorObjectRef({ ...ref, objectId: 'C:\\secret.txt' }), false);
});

function request(): ExecutorDispatchV1 {
  return {
    protocolVersion: EXECUTOR_PROTOCOL_VERSION,
    runId: 'run-1',
    workflowId: 'workflow-1',
    stepId: 'approve',
    execution: {
      jobId: 'run-1/approve',
      attemptId: 'run-1/approve/attempt-0',
      attempt: 0,
    },
    plugin: { name: 'approval', version: '1.2.0' },
    idempotencyKey: 'run-1/approve',
    policyVersion: 'policy-1',
    deadlineAt: '2026-09-25T10:05:00.000Z',
    requiredCapabilities: ['execution.wait'],
    input: { config: { approvalId: 'a-1' }, context: { traceId: 'trace-1' } },
    secretRefs: { apiKey: 'secret://project/api-key' },
  };
}

function fence(): ExecutorFenceState {
  return {
    execution: request().execution,
    leaseToken: 'lease-1',
    leaseExpiresAt: '2026-09-25T10:01:00.000Z',
    lastSequence: 0,
    terminal: false,
  };
}

function message(kind: ExecutorMessageV1['kind'] = 'heartbeat'): ExecutorMessageV1 {
  const base = {
    protocolVersion: EXECUTOR_PROTOCOL_VERSION,
    execution: request().execution,
    leaseToken: 'lease-1',
    sequence: 1,
    occurredAt: NOW.toISOString(),
  };
  if (kind === 'event') {
    return { ...base, kind, eventType: 'plugin:log', payloadVersion: 1, payload: { line: 'ok' } };
  }
  if (kind === 'complete') return { ...base, kind, result: { success: true, data: { ok: true } } };
  if (kind === 'wait') {
    return {
      ...base,
      kind,
      checkpoint: { cursor: 1 },
      condition: { kind: 'signal', key: 'approved' },
    };
  }
  return { ...base, kind };
}

describe('Executor protocol v1', () => {
  it('accepts only a JSON-safe, identity-consistent dispatch', () => {
    assert.doesNotThrow(() => validateExecutorDispatch(request()));
    const otherRealmInput = runInNewContext(
      'JSON.parse(\'{"config":{"type":"unit"},"context":{}}\')',
    );
    assert.doesNotThrow(() => validateExecutorDispatch({ ...request(), input: otherRealmInput }));
    assert.throws(
      () => validateExecutorDispatch({ ...request(), protocolVersion: 2 }),
      /protocol version/,
    );
    assert.throws(
      () => validateExecutorDispatch({ ...request(), stepId: 'different' }),
      /identity/,
    );
    assert.throws(
      () => validateExecutorDispatch({ ...request(), requiredCapabilities: ['a', 'a'] }),
      /capabilities/,
    );
    assert.throws(
      () =>
        validateExecutorDispatch({ ...request(), input: { config: { value: NaN }, context: {} } }),
      /JSON/,
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.throws(
      () => validateExecutorDispatch({ ...request(), input: { config: cyclic, context: {} } }),
      /JSON/,
    );
    assert.throws(
      () => validateExecutorDispatch({ ...request(), secretRefs: { apiKey: '' } }),
      /secret references/,
    );
    assert.throws(
      () => validateExecutorDispatch({ ...request(), secretRefs: { apiKey: 'plaintext' } }),
      /secret references/,
    );
    assert.throws(
      () =>
        validateExecutorDispatch({
          ...request(),
          input: { config: { blob: 'x'.repeat(EXECUTOR_DATA_MAX_BYTES) }, context: {} },
        }),
      /too large/,
    );
  });

  it('fences stale, expired, duplicate and out-of-order messages', () => {
    const base = message();
    assert.deepEqual(assessExecutorMessage(request(), fence(), null, NOW), {
      accepted: false,
      code: 'invalid_payload',
    });
    assert.deepEqual(assessExecutorMessage(request(), fence(), { ...base, execution: null }, NOW), {
      accepted: false,
      code: 'invalid_identity',
    });
    assert.deepEqual(
      assessExecutorMessage(request(), fence(), { ...base, leaseToken: 'old' }, NOW),
      { accepted: false, code: 'stale_lease' },
    );
    assert.deepEqual(assessExecutorMessage(request(), fence(), { ...base, sequence: 2 }, NOW), {
      accepted: false,
      code: 'out_of_order',
    });
    const accepted = assessExecutorMessage(request(), fence(), base, NOW);
    assert.equal(accepted.accepted, true);
    if (!accepted.accepted) return;
    assert.equal(accepted.next.lastSequence, 1);
    assert.deepEqual(assessExecutorMessage(request(), accepted.next, base, NOW), {
      accepted: false,
      code: 'duplicate',
    });
    assert.deepEqual(
      assessExecutorMessage(request(), fence(), base, new Date('2026-09-25T10:01:00.000Z')),
      { accepted: false, code: 'expired_lease' },
    );
    assert.deepEqual(
      assessExecutorMessage(
        request(),
        { ...fence(), leaseExpiresAt: '2026-09-25T10:10:00.000Z' },
        base,
        new Date('2026-09-25T10:05:00.000Z'),
      ),
      { accepted: false, code: 'deadline_exceeded' },
    );
  });

  it('accepts bounded events and rejects malformed or excessive payloads', () => {
    assert.equal(assessExecutorMessage(request(), fence(), message('event'), NOW).accepted, true);
    assert.deepEqual(
      assessExecutorMessage(
        request(),
        fence(),
        {
          ...message('event'),
          payload: { line: 'x'.repeat(EXECUTOR_EVENT_MAX_BYTES) },
        } as ExecutorMessageV1,
        NOW,
      ),
      { accepted: false, code: 'payload_too_large' },
    );
    assert.deepEqual(
      assessExecutorMessage(
        request(),
        fence(),
        { ...message('event'), payloadVersion: 0 } as ExecutorMessageV1,
        NOW,
      ),
      { accepted: false, code: 'invalid_payload' },
    );
  });

  it('separates completion from durable wait and makes terminal messages single-use', () => {
    const complete = assessExecutorMessage(request(), fence(), message('complete'), NOW);
    assert.equal(complete.accepted, true);
    if (!complete.accepted) return;
    assert.equal(complete.next.terminal, true);
    assert.deepEqual(
      assessExecutorMessage(request(), complete.next, { ...message(), sequence: 2 }, NOW),
      { accepted: false, code: 'already_terminal' },
    );
    assert.deepEqual(
      assessExecutorMessage(
        request(),
        fence(),
        {
          ...message('complete'),
          result: {
            success: true,
            wait: { checkpoint: {}, condition: { kind: 'signal', key: 'x' } },
          },
        } as ExecutorMessageV1,
        NOW,
      ),
      { accepted: false, code: 'invalid_payload' },
    );
    assert.equal(assessExecutorMessage(request(), fence(), message('wait'), NOW).accepted, true);
    assert.deepEqual(
      assessExecutorMessage(
        request(),
        fence(),
        {
          ...message('complete'),
          result: { success: true, data: 'x'.repeat(EXECUTOR_DATA_MAX_BYTES) },
        },
        NOW,
      ),
      { accepted: false, code: 'payload_too_large' },
    );
    assert.deepEqual(
      assessExecutorMessage(
        request(),
        fence(),
        { ...message('wait'), checkpoint: 'x'.repeat(EXECUTOR_DATA_MAX_BYTES) },
        NOW,
      ),
      { accepted: false, code: 'payload_too_large' },
    );
    assert.deepEqual(
      assessExecutorMessage(
        { ...request(), requiredCapabilities: [] },
        fence(),
        message('wait'),
        NOW,
      ),
      { accepted: false, code: 'wait_not_allowed' },
    );
    assert.deepEqual(
      assessExecutorMessage(
        request(),
        fence(),
        { ...message('wait'), condition: { kind: 'signal', key: ' ' } } as ExecutorMessageV1,
        NOW,
      ),
      { accepted: false, code: 'invalid_payload' },
    );
  });

  it('accepts cancellation only for the current execution and lease', () => {
    const command = {
      protocolVersion: EXECUTOR_PROTOCOL_VERSION,
      requestId: 'cancel-1',
      execution: request().execution,
      leaseToken: 'lease-1',
      mode: 'hard' as const,
      reason: 'user_cancel' as const,
    };
    assert.equal(assessExecutorCancel(request(), fence(), command).accepted, true);
    assert.deepEqual(assessExecutorCancel(request(), fence(), { ...command, leaseToken: 'old' }), {
      accepted: false,
      code: 'stale_lease',
    });
    assert.deepEqual(assessExecutorCancel(request(), { ...fence(), terminal: true }, command), {
      accepted: false,
      code: 'already_terminal',
    });
  });
});
