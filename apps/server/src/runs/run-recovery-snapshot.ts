import {
  AttemptStatuses,
  createExecutionIdentity,
  resolveRetryPolicy,
  SkipReasons,
  StepStatuses,
  type ExecutionResult,
  type WorkflowResumeSnapshot,
} from '@monai-devops/core-engine';
import type { RecoveryJob } from '../execution/execution.repository.js';
import type { RunRecord } from './runs.repository.js';

export class RunRecoveryNotReadyError extends Error {
  constructor(
    message: string,
    readonly permanent = true,
  ) {
    super(message);
    this.name = 'RunRecoveryNotReadyError';
  }
}

function reject(reason: string, permanent = true): never {
  throw new RunRecoveryNotReadyError(reason, permanent);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * 从 Run 的事件与权威 Job/Attempt 状态构建执行器快照。
 * 此函数只重建、校验，不认领 Run；调用方必须先获得 Run 级独占执行权。
 */
export function buildRunRecoverySnapshot(
  run: RunRecord,
  jobs: readonly RecoveryJob[],
  initialState: { present: boolean; value?: unknown } = { present: false },
): WorkflowResumeSnapshot {
  if (
    run.status !== 'queued' &&
    run.status !== 'running' &&
    run.status !== 'waiting' &&
    run.status !== 'paused'
  ) {
    reject(`Run ${run.runId} 的状态 ${run.status} 不允许直接续跑`);
  }
  if (run.result || run.events.some((event) => event.type === 'workflow:finished')) {
    reject('已有工作流终态，不能重建活跃 Run');
  }
  if (run.counts.failed > 0) {
    reject('含失败步骤的 Run 尚不支持快照续跑');
  }

  const steps = new Map(run.workflowSnapshot.steps.map((step) => [step.id, step]));
  if (
    steps.size !== run.workflowSnapshot.steps.length ||
    run.counts.total !== run.workflowSnapshot.steps.length
  ) {
    reject('Run 步骤总数与工作流快照不一致');
  }
  const completed = new Map<string, ExecutionResult>();
  const skipped = new Map<string, ExecutionResult>();
  let latestState: unknown;
  let hasSetState = false;

  for (const event of run.events) {
    if (event.type !== 'step:finished' || event.workflowRunId !== run.runId || event.parent) {
      continue;
    }
    const step = asRecord(event.step);
    const result = asRecord(event.result);
    const stepId = step?.id;
    if (typeof stepId !== 'string' || !steps.has(stepId) || result?.stepId !== stepId) {
      reject('步骤完成事件与工作流快照不一致');
    }
    if (result?.status === StepStatuses.SKIPPED) {
      if (
        result.success !== true ||
        result.skipReason !== SkipReasons.CONDITION_NOT_MET ||
        !steps.get(stepId)?.condition ||
        completed.has(stepId) ||
        skipped.has(stepId)
      ) {
        reject(`步骤 ${stepId} 的跳过事件重复或不可安全续跑`);
      }
      skipped.set(stepId, result as unknown as ExecutionResult);
      continue;
    }
    if (result?.status !== StepStatuses.COMPLETED) continue;
    if (
      result.success !== true ||
      asRecord(result.pluginResult)?.success !== true ||
      completed.has(stepId) ||
      skipped.has(stepId)
    ) {
      reject(`步骤 ${stepId} 的完成事件重复或不完整`);
    }
    completed.set(stepId, result as unknown as ExecutionResult);
    if (steps.get(stepId)?.kind === 'set_state') {
      const state = asRecord(result.pluginResult)?.data;
      if (state === undefined) reject(`set_state 步骤 ${stepId} 缺少 state 输出`);
      latestState = state;
      hasSetState = true;
    }
  }

  if (completed.size !== run.counts.completed) {
    reject('步骤完成事件与 Run 计数不一致，可能已被裁剪或尚未完成投影');
  }
  if (skipped.size !== run.counts.skipped) {
    reject('步骤跳过事件与 Run 计数不一致，可能已被裁剪或尚未完成投影');
  }
  const settled = new Map([...completed, ...skipped]);
  for (const [stepId] of settled) {
    const step = steps.get(stepId)!;
    const dependencies = step.dependsOn ?? [];
    if (dependencies.some((dependencyId) => !settled.has(dependencyId))) {
      reject(`步骤 ${stepId} 缺少已结算的依赖事件`);
    }
  }

  const nextAttemptByStep: Record<string, number> = {};
  const readyWaitsByStep: NonNullable<WorkflowResumeSnapshot['readyWaitsByStep']> = {};
  const seenJobs = new Set<string>();
  for (const job of jobs) {
    const step = steps.get(job.stepId);
    if (!step || seenJobs.has(job.stepId)) reject(`Job 对应未知或重复步骤：${job.stepId}`);
    seenJobs.add(job.stepId);
    const latest = job.attempts[job.attempts.length - 1];
    if (!latest) reject(`Job ${job.stepId} 缺少 Attempt`);
    if (job.attempts.some((attempt, index) => attempt.attempt !== index)) {
      reject(`Job ${job.stepId} 的 Attempt 序号不连续`);
    }
    if (settled.has(job.stepId)) {
      const expected = completed.has(job.stepId)
        ? AttemptStatuses.SUCCEEDED
        : AttemptStatuses.SKIPPED;
      if (latest.status !== expected || job.status !== expected) {
        reject(`步骤 ${job.stepId} 的完成事件与 Attempt 状态不一致`);
      }
      continue;
    }
    if (latest.status === AttemptStatuses.QUEUED && job.status === AttemptStatuses.QUEUED) {
      if (latest.attempt > 0 && !job.idempotencyKey?.trim()) {
        reject(`步骤 ${job.stepId} 缺少重试幂等键`);
      }
      nextAttemptByStep[job.stepId] = latest.attempt;
      continue;
    }
    if (latest.status === AttemptStatuses.WAITING && job.status === AttemptStatuses.WAITING) {
      if (!latest.wakeReadyAt) reject(`步骤 ${job.stepId} 的 waiting Attempt 尚未被唤醒`, false);
      if (step.kind !== undefined && step.kind !== 'plugin') {
        reject(`步骤 ${job.stepId} 不是可续跑的插件步骤`);
      }
      const identity = createExecutionIdentity(run.runId, job.stepId, latest.attempt);
      const checkpoint = asRecord(job.checkpoint);
      if (
        !checkpoint ||
        checkpoint.jobId !== identity.jobId ||
        checkpoint.sourceAttemptId !== identity.attemptId ||
        !Number.isInteger(checkpoint.version) ||
        (checkpoint.version as number) < 1 ||
        latest.attempt + (latest.remoteDispatch ? 1 : 0) >=
          resolveRetryPolicy(step.retryPolicy).maxAttempts
      ) {
        reject(`步骤 ${job.stepId} 的 waiting checkpoint 无效`);
      }
      readyWaitsByStep[job.stepId] = {
        attempt: latest.attempt + (latest.remoteDispatch ? 1 : 0),
        checkpoint: job.checkpoint!,
        ...(latest.wakePayload !== undefined ? { wakePayload: latest.wakePayload } : {}),
      };
      continue;
    }
    if (latest.status === AttemptStatuses.TIMED_OUT || latest.status === AttemptStatuses.FAILED) {
      const retryable =
        latest.status === AttemptStatuses.TIMED_OUT || asRecord(latest.reason)?.retryable === true;
      const nextAttempt = latest.attempt + 1;
      if (!job.idempotencyKey?.trim()) reject(`步骤 ${job.stepId} 缺少重试幂等键`);
      if (!retryable || nextAttempt >= resolveRetryPolicy(step.retryPolicy).maxAttempts) {
        reject(`步骤 ${job.stepId} 已失败且无可用重试 Attempt`);
      }
      nextAttemptByStep[job.stepId] = nextAttempt;
      continue;
    }
    reject(
      `步骤 ${job.stepId} 处于 ${latest.status}，不能直接构建续跑快照`,
      latest.status !== AttemptStatuses.LEASED && latest.status !== AttemptStatuses.RUNNING,
    );
  }
  for (const stepId of settled.keys()) {
    if (!seenJobs.has(stepId)) reject(`已结算步骤 ${stepId} 缺少 Job`);
  }

  const snapshot: WorkflowResumeSnapshot = {
    completedResults: [...completed.values()],
    ...(skipped.size > 0 ? { skippedResults: [...skipped.values()] } : {}),
    ...(Object.keys(readyWaitsByStep).length > 0 ? { readyWaitsByStep } : {}),
    nextAttemptByStep,
  };
  if (run.workflowSnapshot.stateSchema !== undefined) {
    if (hasSetState) {
      snapshot.state = latestState;
    } else if (initialState.present) {
      snapshot.state = initialState.value;
    } else {
      reject('有 stateSchema 的 Run 缺少可恢复 state');
    }
  }
  return snapshot;
}
