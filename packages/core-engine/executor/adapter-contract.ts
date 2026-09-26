import type { PluginResult } from '@monai-devops/plugin-sdk';
import { createExecutionIdentity, type ExecutionIdentity } from './execution-identity.js';
import { validateWakeCondition, type ExecutionWakeCondition } from '../reliability/index.js';

/** Transport-independent Core-3 contract. Authority still belongs to the persistent lease CAS. */
export const EXECUTOR_PROTOCOL_VERSION = 1 as const;
export const EXECUTOR_EVENT_MAX_BYTES = 64 * 1024;
export const EXECUTOR_DATA_MAX_BYTES = 1024 * 1024;

export type ExecutorJsonValue =
  | null
  | boolean
  | number
  | string
  | ExecutorJsonValue[]
  | { [key: string]: ExecutorJsonValue };
export type ExecutorJsonObject = { [key: string]: ExecutorJsonValue };

export interface ExecutorDispatchV1 {
  protocolVersion: typeof EXECUTOR_PROTOCOL_VERSION;
  runId: string;
  workflowId: string;
  stepId: string;
  execution: ExecutionIdentity;
  plugin: { name: string; version: string };
  idempotencyKey: string;
  policyVersion: string;
  traceId?: string;
  deadlineAt?: string;
  requiredCapabilities: string[];
  /** Public, JSON-only input. Secret values must never be included here. */
  input: { config: ExecutorJsonObject; context: ExecutorJsonObject };
  /** Opaque references only; resolution and authorization belong to the selected worker. */
  secretRefs?: Record<string, string>;
}

export interface ExecutorLeaseClaimV1 {
  protocolVersion: typeof EXECUTOR_PROTOCOL_VERSION;
  execution: ExecutionIdentity;
  workerId: string;
  leaseToken: string;
  leaseExpiresAt: string;
  /** Server-persisted next message sequence; may be greater than 1 after a lease takeover. */
  nextSequence: number;
}

interface ExecutorMessageBaseV1 {
  protocolVersion: typeof EXECUTOR_PROTOCOL_VERSION;
  execution: ExecutionIdentity;
  leaseToken: string;
  sequence: number;
  occurredAt: string;
}

export type ExecutorMessageV1 =
  | (ExecutorMessageBaseV1 & { kind: 'heartbeat' })
  | (ExecutorMessageBaseV1 & {
      kind: 'event';
      eventType: string;
      payloadVersion: number;
      payload: ExecutorJsonValue;
    })
  | (ExecutorMessageBaseV1 & { kind: 'complete'; result: PluginResult })
  | (ExecutorMessageBaseV1 & {
      kind: 'wait';
      checkpoint: ExecutorJsonValue;
      condition: ExecutionWakeCondition;
    });

/** Run pause without abortInFlight stays in the server scheduler; workers only receive cancellation. */
export interface ExecutorCancelV1 {
  protocolVersion: typeof EXECUTOR_PROTOCOL_VERSION;
  requestId: string;
  execution: ExecutionIdentity;
  leaseToken: string;
  mode: 'best-effort' | 'hard';
  reason: 'user_cancel' | 'pause_abort' | 'lease_lost' | 'deadline';
}

/** Dispatch is idempotent by attemptId; messages are accepted by a durable, token-fenced sink. */
export interface ExecutorAdapterV1 {
  readonly kind: 'local' | 'remote';
  dispatch(request: ExecutorDispatchV1): Promise<void>;
  cancel(command: ExecutorCancelV1): Promise<void>;
}

export interface ExecutorFenceState {
  execution: ExecutionIdentity;
  leaseToken: string;
  leaseExpiresAt: string;
  lastSequence: number;
  terminal: boolean;
}

export type ExecutorRejectCode =
  | 'unsupported_version'
  | 'invalid_identity'
  | 'stale_lease'
  | 'expired_lease'
  | 'deadline_exceeded'
  | 'duplicate'
  | 'out_of_order'
  | 'already_terminal'
  | 'invalid_payload'
  | 'payload_too_large'
  | 'wait_not_allowed';

export type ExecutorMessageDecision =
  | { accepted: true; next: ExecutorFenceState }
  | { accepted: false; code: ExecutorRejectCode };

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonValue(value: unknown, seen = new WeakSet<object>(), depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  try {
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      return false;
    }
    seen.add(value);
    const children = Array.isArray(value) ? value : Object.values(value);
    const valid = children.every((child) => jsonValue(child, seen, depth + 1));
    seen.delete(value);
    return valid;
  } catch {
    return false;
  }
}

function sameExecution(left: unknown, right: ExecutionIdentity): boolean {
  return (
    record(left) &&
    left.jobId === right.jobId &&
    left.attemptId === right.attemptId &&
    left.attempt === right.attempt
  );
}

/** Reject malformed or non-serializable dispatches before an adapter sees them. */
export function validateExecutorDispatch(value: unknown): asserts value is ExecutorDispatchV1 {
  if (!record(value) || value.protocolVersion !== EXECUTOR_PROTOCOL_VERSION) {
    throw new Error('unsupported executor protocol version');
  }
  const execution = value.execution;
  if (
    !nonEmpty(value.runId) ||
    !nonEmpty(value.workflowId) ||
    !nonEmpty(value.stepId) ||
    !record(execution) ||
    !Number.isInteger(execution.attempt) ||
    (execution.attempt as number) < 0 ||
    !sameExecution(
      execution,
      createExecutionIdentity(value.runId, value.stepId, execution.attempt as number),
    )
  ) {
    throw new Error('invalid executor execution identity');
  }
  if (
    !record(value.plugin) ||
    !nonEmpty(value.plugin.name) ||
    !nonEmpty(value.plugin.version) ||
    !nonEmpty(value.idempotencyKey) ||
    !nonEmpty(value.policyVersion) ||
    (value.traceId !== undefined && !nonEmpty(value.traceId)) ||
    (value.deadlineAt !== undefined && !validTime(value.deadlineAt))
  ) {
    throw new Error('invalid executor dispatch metadata');
  }
  if (
    !Array.isArray(value.requiredCapabilities) ||
    value.requiredCapabilities.some((item) => !nonEmpty(item)) ||
    new Set(value.requiredCapabilities).size !== value.requiredCapabilities.length
  ) {
    throw new Error('invalid executor capabilities');
  }
  if (
    !record(value.input) ||
    !record(value.input.config) ||
    !record(value.input.context) ||
    !jsonValue(value.input)
  ) {
    throw new Error('executor input must be JSON objects');
  }
  if (Buffer.byteLength(JSON.stringify(value.input), 'utf8') > EXECUTOR_DATA_MAX_BYTES) {
    throw new Error('executor input payload too large');
  }
  if (
    value.secretRefs !== undefined &&
    (!record(value.secretRefs) ||
      !jsonValue(value.secretRefs) ||
      Object.entries(value.secretRefs).some(
        ([key, ref]) => !nonEmpty(key) || !nonEmpty(ref) || !ref.startsWith('secret://'),
      ))
  ) {
    throw new Error('invalid executor secret references');
  }
}

/** Pure preflight only. The caller must repeat ownership and sequence checks in one DB CAS. */
export function assessExecutorMessage(
  request: ExecutorDispatchV1,
  fence: ExecutorFenceState,
  message: unknown,
  now = new Date(),
): ExecutorMessageDecision {
  const reject = (code: ExecutorRejectCode): ExecutorMessageDecision => ({ accepted: false, code });
  if (!record(message)) return reject('invalid_payload');
  if (message.protocolVersion !== EXECUTOR_PROTOCOL_VERSION) return reject('unsupported_version');
  if (
    !sameExecution(message.execution, request.execution) ||
    !sameExecution(message.execution, fence.execution)
  )
    return reject('invalid_identity');
  if (!nonEmpty(message.leaseToken) || message.leaseToken !== fence.leaseToken)
    return reject('stale_lease');
  if (!Number.isInteger(message.sequence) || (message.sequence as number) < 1)
    return reject('invalid_payload');
  const sequence = message.sequence as number;
  if (sequence <= fence.lastSequence) return reject('duplicate');
  if (sequence !== fence.lastSequence + 1) return reject('out_of_order');
  if (fence.terminal) return reject('already_terminal');
  if (!validTime(fence.leaseExpiresAt) || Date.parse(fence.leaseExpiresAt) <= now.getTime())
    return reject('expired_lease');
  if (request.deadlineAt && Date.parse(request.deadlineAt) <= now.getTime())
    return reject('deadline_exceeded');
  if (!validTime(message.occurredAt)) return reject('invalid_payload');
  const candidate = message as unknown as ExecutorMessageV1;
  if (candidate.kind === 'event') {
    if (
      !nonEmpty(candidate.eventType) ||
      !Number.isInteger(candidate.payloadVersion) ||
      candidate.payloadVersion < 1 ||
      !jsonValue(candidate.payload)
    )
      return reject('invalid_payload');
    if (Buffer.byteLength(JSON.stringify(candidate.payload), 'utf8') > EXECUTOR_EVENT_MAX_BYTES) {
      return reject('payload_too_large');
    }
  } else if (candidate.kind === 'complete') {
    if (
      !record(candidate.result) ||
      typeof candidate.result.success !== 'boolean' ||
      candidate.result.wait !== undefined ||
      !jsonValue(candidate.result)
    )
      return reject('invalid_payload');
    if (Buffer.byteLength(JSON.stringify(candidate.result), 'utf8') > EXECUTOR_DATA_MAX_BYTES)
      return reject('payload_too_large');
  } else if (candidate.kind === 'wait') {
    if (!request.requiredCapabilities.includes('execution.wait')) return reject('wait_not_allowed');
    if (!jsonValue(candidate.checkpoint)) return reject('invalid_payload');
    if (Buffer.byteLength(JSON.stringify(candidate.checkpoint), 'utf8') > EXECUTOR_DATA_MAX_BYTES)
      return reject('payload_too_large');
    try {
      validateWakeCondition(candidate.condition);
    } catch {
      return reject('invalid_payload');
    }
  } else if (candidate.kind !== 'heartbeat') {
    return reject('invalid_payload');
  }
  return {
    accepted: true,
    next: {
      ...fence,
      lastSequence: sequence,
      terminal: candidate.kind === 'complete' || candidate.kind === 'wait',
    },
  };
}

export function assessExecutorCancel(
  request: ExecutorDispatchV1,
  fence: ExecutorFenceState,
  command: unknown,
): ExecutorMessageDecision {
  const reject = (code: ExecutorRejectCode): ExecutorMessageDecision => ({ accepted: false, code });
  if (!record(command)) return reject('invalid_payload');
  if (command.protocolVersion !== EXECUTOR_PROTOCOL_VERSION) return reject('unsupported_version');
  if (
    !sameExecution(command.execution, request.execution) ||
    !sameExecution(command.execution, fence.execution)
  )
    return reject('invalid_identity');
  if (!nonEmpty(command.leaseToken) || command.leaseToken !== fence.leaseToken)
    return reject('stale_lease');
  if (fence.terminal) return reject('already_terminal');
  if (
    !nonEmpty(command.requestId) ||
    (command.mode !== 'best-effort' && command.mode !== 'hard') ||
    (command.reason !== 'user_cancel' &&
      command.reason !== 'pause_abort' &&
      command.reason !== 'lease_lost' &&
      command.reason !== 'deadline')
  )
    return reject('invalid_payload');
  return { accepted: true, next: fence };
}
