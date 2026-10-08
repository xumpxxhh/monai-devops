import { EXECUTOR_PROTOCOL_VERSION, type ExecutorMessageV1 } from '@monai-devops/core-engine';
import { validWorkerEvent } from './worker-event-policy.js';

describe('worker event policy', () => {
  const event: ExecutorMessageV1 = {
    protocolVersion: EXECUTOR_PROTOCOL_VERSION,
    execution: { jobId: 'run/step', attemptId: 'run/step/attempt-0', attempt: 0 },
    leaseToken: 'token',
    sequence: 1,
    occurredAt: new Date().toISOString(),
    kind: 'event',
    eventType: 'plugin:log',
    payloadVersion: 1,
    payload: { level: 'info', message: 'ok', timestamp: 1 },
  };

  it('accepts only bounded versioned log messages', () => {
    expect(validWorkerEvent(event)).toBe(true);
    expect(validWorkerEvent({ ...event, eventType: 'custom' })).toBe(false);
    expect(
      validWorkerEvent({
        ...event,
        payload: { level: 'info', message: 'x'.repeat(4_097), timestamp: 1 },
      }),
    ).toBe(false);
    expect(
      validWorkerEvent({
        ...event,
        payload: { level: 'info', message: 'ok', timestamp: 1, secret: 'x' },
      }),
    ).toBe(false);
    const objectRef = {
      version: 1,
      objectId: '12345678-1234-1234-1234-123456789abc',
      kind: 'log',
      contentType: 'text/plain',
      sizeBytes: 5_000,
      sha256: 'a'.repeat(64),
      expiresAt: '2026-10-15T00:00:00.000Z',
    };
    expect(
      validWorkerEvent({
        ...event,
        payload: { level: 'info', message: 'stored', timestamp: 1, objectRef },
      }),
    ).toBe(true);
    expect(
      validWorkerEvent({
        ...event,
        payload: {
          level: 'info',
          message: 'stored',
          timestamp: 1,
          objectRef: { ...objectRef, kind: 'result', contentType: 'application/json' },
        },
      }),
    ).toBe(false);
  });
});
