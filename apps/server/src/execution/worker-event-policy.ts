import { isExecutorObjectRef, type ExecutorMessageV1 } from '@monai-devops/core-engine';

export const MAX_WORKER_LOG_EVENTS = 100;
export const MAX_WORKER_LOG_CHARS = 4_096;

/** The experimental transport persists only a small, schema-checked log event. */
export function validWorkerEvent(message: ExecutorMessageV1): boolean {
  if (message.kind !== 'event') return true;
  if (message.eventType !== 'plugin:log' || message.payloadVersion !== 1) return false;
  const payload = message.payload;
  return (
    payload !== null &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    (payload.level === 'debug' ||
      payload.level === 'info' ||
      payload.level === 'warn' ||
      payload.level === 'error') &&
    typeof payload.message === 'string' &&
    payload.message.length <= MAX_WORKER_LOG_CHARS &&
    typeof payload.timestamp === 'number' &&
    Number.isFinite(payload.timestamp) &&
    (payload.stream === undefined || payload.stream === 'stdout' || payload.stream === 'stderr') &&
    (payload.objectRef === undefined ||
      (isExecutorObjectRef(payload.objectRef) && payload.objectRef.kind === 'log')) &&
    Object.keys(payload).every((key) =>
      ['level', 'message', 'timestamp', 'stream', 'objectRef'].includes(key),
    )
  );
}
