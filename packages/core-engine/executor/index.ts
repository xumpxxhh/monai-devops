/**
 * 流程执行器
 * @module executor
 */

import { noopLogger, PluginContextKeys, type PluginResult } from '@monai-devops/plugin-sdk';
import {
  ResourceQueueCancelledError,
  RunAlreadyActiveError,
  StepExecutionError,
  SkipReasons,
  StepFailureKinds,
  StepStatuses,
  WorkflowRunIdValidationError,
  WorkflowValidationError,
} from '../errors.js';
import type { SkipReason } from '../errors.js';
import type { WorkflowLifecycleEvent, WorkflowRunMeta } from '../observer/index.js';
import { WorkflowEventTypes } from '../observer/event-types.js';
import { createContextLogger } from '../plugin/create-context-logger.js';
import { WorkflowContextKeys } from '../context-keys.js';
import {
  buildCompletedResult,
  buildFailedResult,
  buildSkippedResult,
  pluginFailureKind,
} from './helpers.js';
import { RunHandle } from './run-handle.js';
import { RunRegistry } from './run-registry.js';
import type {
  AbortSchedulingReason,
  CancelRunOptions,
  ExecutionContext,
  ExecutionResult,
  ExecutorOptions,
  PauseRunOptions,
  RunControlMode,
  RunControlResult,
  RunStatusSnapshot,
  StepCondition,
  WorkflowDefinition,
  WorkflowRunResult,
  WorkflowRunStatus,
  WorkflowStep,
} from './types.js';

export type {
  AbortSchedulingReason,
  CancelRunOptions,
  ExecutionContext,
  ExecutionResult,
  ExecutorOptions,
  PauseRunOptions,
  PluginExecutor,
  RunControlMode,
  RunControlResult,
  RunControlStatus,
  RunStatusSnapshot,
  StepCondition,
  WorkflowDefinition,
  WorkflowRunResult,
  WorkflowRunStatus,
  WorkflowStep,
} from './types.js';

export { RunHandle } from './run-handle.js';
export { RunRegistry } from './run-registry.js';
export {
  RunAlreadyActiveError,
  WorkflowRunIdValidationError,
  WorkflowValidationError,
} from '../errors.js';

const WORKFLOW_RUN_ID_MAX_LENGTH = 128;
const WORKFLOW_RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function assertValidWorkflowRunId(id: unknown): asserts id is string {
  if (typeof id !== 'string') {
    throw new WorkflowRunIdValidationError('workflowRunId 必须为字符串');
  }

  const trimmed = id.trim();
  if (trimmed.length === 0) {
    throw new WorkflowRunIdValidationError('workflowRunId 不能为空');
  }

  if (trimmed.length > WORKFLOW_RUN_ID_MAX_LENGTH) {
    throw new WorkflowRunIdValidationError(
      `workflowRunId 长度不能超过 ${WORKFLOW_RUN_ID_MAX_LENGTH} 字符`,
    );
  }

  if (!WORKFLOW_RUN_ID_PATTERN.test(trimmed)) {
    throw new WorkflowRunIdValidationError('workflowRunId 仅允许字母、数字、下划线与连字符');
  }
}

interface DagGraph {
  stepIds: Set<string>;
  inDegree: Map<string, number>;
  dependents: Map<string, string[]>;
  stepById: Map<string, WorkflowStep>;
}

function buildDag(steps: WorkflowStep[]): DagGraph {
  const stepById = new Map<string, WorkflowStep>();
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const step of steps) {
    if (stepById.has(step.id)) {
      throw new WorkflowValidationError(`重复的步骤 ID: ${step.id}`);
    }
    stepById.set(step.id, step);
    inDegree.set(step.id, 0);
    dependents.set(step.id, []);
  }

  for (const step of steps) {
    const deps = step.dependsOn ?? [];
    for (const depId of deps) {
      if (!stepById.has(depId)) {
        throw new WorkflowValidationError(`步骤 ${step.id} 依赖不存在的步骤: ${depId}`);
      }
      inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1);
      dependents.get(depId)!.push(step.id);
    }
  }

  return {
    stepIds: new Set(stepById.keys()),
    inDegree,
    dependents,
    stepById,
  };
}

function validateDag(steps: WorkflowStep[]): DagGraph {
  const graph = buildDag(steps);
  const queue: string[] = [];
  const degrees = new Map(graph.inDegree);

  for (const [id, degree] of degrees) {
    if (degree === 0) queue.push(id);
  }

  let visited = 0;
  const queueCopy = [...queue];

  while (queueCopy.length > 0) {
    const id = queueCopy.shift()!;
    visited++;
    for (const dependent of graph.dependents.get(id) ?? []) {
      const next = (degrees.get(dependent) ?? 0) - 1;
      degrees.set(dependent, next);
      if (next === 0) queueCopy.push(dependent);
    }
  }

  if (visited !== graph.stepIds.size) {
    throw new WorkflowValidationError('工作流存在循环依赖');
  }

  return graph;
}

function checkCondition(
  condition: StepCondition | undefined,
  previousResults: Record<string, unknown>,
): boolean {
  if (!condition) return true;

  const value = previousResults[condition.when];

  if (condition.exists !== undefined) {
    const exists = value !== undefined && value !== null;
    return condition.exists ? exists : !exists;
  }

  if (condition.equals !== undefined) {
    return value === condition.equals;
  }

  return value !== undefined && value !== null;
}

function allDependenciesSucceeded(
  step: WorkflowStep,
  results: Map<string, ExecutionResult>,
): boolean {
  const deps = step.dependsOn ?? [];
  return deps.every((depId) => {
    const result = results.get(depId);
    return result !== undefined && result.status !== StepStatuses.FAILED;
  });
}

function toPreviousResults(results: Map<string, ExecutionResult>): Record<string, unknown> {
  const acc: Record<string, unknown> = {};
  for (const [stepId, r] of results) {
    if (r.status !== StepStatuses.FAILED) {
      acc[stepId] = r.result;
    }
  }
  return acc;
}

function stripCallerRunId(context: Partial<ExecutionContext>): Partial<ExecutionContext> {
  const { runId, ...rest } = context;
  void runId;
  return rest;
}

function buildRunMeta(workflowId: string, context: Partial<ExecutionContext>): WorkflowRunMeta {
  const traceId =
    typeof context.traceId === 'string' && context.traceId.length > 0 ? context.traceId : undefined;

  return {
    workflowId,
    traceId,
    context: stripCallerRunId(context),
  };
}

function buildEvent(
  workflowRunId: string,
  event: { type: WorkflowLifecycleEvent['type'] } & Record<string, unknown>,
): WorkflowLifecycleEvent {
  return { ...event, workflowRunId } as WorkflowLifecycleEvent;
}

function resolveAbortSkipReason(reason: AbortSchedulingReason): SkipReason {
  if (reason === 'fail_fast') return SkipReasons.WORKFLOW_ABORTED;
  if (reason === 'user_cancel' || reason === 'destroy') return SkipReasons.USER_CANCELLED;
  return SkipReasons.WORKFLOW_ABORTED;
}

async function racePluginWithHardCancelTimeout(
  execute: () => Promise<PluginResult>,
  signal: AbortSignal | undefined,
  getCancelMode: () => RunControlMode,
  timeoutMs: number,
): Promise<PluginResult | 'hard_cancel_timeout'> {
  if (!signal) {
    return execute();
  }

  return new Promise<PluginResult | 'hard_cancel_timeout'>((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      signal.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      if (getCancelMode() !== 'hard') return;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        cleanup();
        resolve('hard_cancel_timeout');
      }, timeoutMs);
    };

    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort);
    }

    execute().then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function buildWorkflowRunResult(
  workflowId: string,
  finalResults: ExecutionResult[],
  handle: RunHandle,
): WorkflowRunResult {
  const hasFailed = finalResults.some((r) => r.status === StepStatuses.FAILED);
  const abortReason = handle.getAbortReason();
  let status: WorkflowRunStatus;
  if (abortReason === 'user_cancel' || abortReason === 'destroy') {
    status = 'cancelled';
  } else if (hasFailed) {
    status = 'failed';
  } else {
    status = 'success';
  }
  return {
    success: status === 'success',
    status,
    workflowId,
    results: finalResults,
  };
}

/**
 * 创建流程执行器
 */
export function createWorkflowExecutor(options: ExecutorOptions = {}) {
  const {
    pluginExecutor,
    maxParallelSteps = 1,
    failFast = true,
    observer,
    onStepStart,
    onStepComplete,
    onStepError,
    onWorkflowAbort,
    inFlightTimeoutMs = 30_000,
  } = options;

  const executionHistory: Map<string, ExecutionResult[]> = new Map();
  const registry = new RunRegistry();

  async function emit(event: WorkflowLifecycleEvent): Promise<void> {
    await observer?.onEvent?.(event);
  }

  async function notifyStepComplete(
    workflowRunId: string,
    step: WorkflowStep,
    executionResult: ExecutionResult,
    context: ExecutionContext,
    meta: WorkflowRunMeta | undefined,
  ): Promise<void> {
    onStepComplete?.(step, executionResult, context);
    if (meta) {
      await emit(
        buildEvent(workflowRunId, {
          type: WorkflowEventTypes.STEP_FINISHED,
          meta,
          step,
          result: executionResult,
        }),
      );
    }
  }

  async function finalizeFailure(
    workflowRunId: string,
    step: WorkflowStep,
    executionResult: ExecutionResult,
    context: ExecutionContext,
    meta: WorkflowRunMeta | undefined,
  ): Promise<ExecutionResult> {
    if (executionResult.error) {
      onStepError?.(step, executionResult.error, context);
    }
    await notifyStepComplete(workflowRunId, step, executionResult, context, meta);
    return executionResult;
  }

  function resolveQueueSkipReason(handle: RunHandle | undefined): SkipReason {
    if (!handle) return SkipReasons.WORKFLOW_ABORTED;
    return resolveAbortSkipReason(handle.getAbortReason());
  }

  async function executeStep(
    workflowRunId: string,
    step: WorkflowStep,
    context: ExecutionContext,
    meta?: WorkflowRunMeta,
    signal?: AbortSignal,
    handle?: RunHandle,
  ): Promise<ExecutionResult> {
    if (meta) {
      assertValidWorkflowRunId(workflowRunId);
    }
    if (!checkCondition(step.condition, context.previousResults ?? {})) {
      const executionResult = buildSkippedResult(step.id, SkipReasons.CONDITION_NOT_MET);
      await notifyStepComplete(workflowRunId, step, executionResult, context, meta);
      return executionResult;
    }

    try {
      await onStepStart?.(step, context, meta);
      if (meta) {
        await emit(
          buildEvent(workflowRunId, {
            type: WorkflowEventTypes.STEP_START,
            meta,
            step,
          }),
        );
      }

      let pluginResult: PluginResult;

      if (pluginExecutor) {
        let flushLogs: (() => Promise<void>) | undefined;
        let pluginContext = context as typeof context & Record<string, unknown>;

        if (meta) {
          const { logger, flush } = createContextLogger({
            emit: (log) =>
              emit(
                buildEvent(workflowRunId, {
                  type: WorkflowEventTypes.PLUGIN_LOG,
                  meta,
                  step,
                  log,
                }),
              ),
          });
          flushLogs = flush;
          pluginContext = {
            ...context,
            [PluginContextKeys.logger]: logger,
            ...(signal ? { [WorkflowContextKeys.signal]: signal } : {}),
          };
        } else {
          pluginContext = { ...context, [PluginContextKeys.logger]: noopLogger };
        }

        if (signal?.aborted) {
          const executionResult = buildSkippedResult(step.id, resolveQueueSkipReason(handle));
          await notifyStepComplete(workflowRunId, step, executionResult, context, meta);
          return executionResult;
        }

        const raced = await racePluginWithHardCancelTimeout(
          () => pluginExecutor(step.plugin, step.config, pluginContext),
          signal,
          () => handle?.getCancelMode() ?? 'best-effort',
          inFlightTimeoutMs,
        );

        if (raced === 'hard_cancel_timeout') {
          const executionResult = buildSkippedResult(step.id, SkipReasons.USER_CANCELLED);
          await notifyStepComplete(workflowRunId, step, executionResult, context, meta);
          return executionResult;
        }

        pluginResult = raced;
        await flushLogs?.();
      } else {
        pluginResult = {
          success: true,
          data: {
            message: `步骤 ${step.name} 执行成功`,
            plugin: step.plugin,
          },
        };
      }

      if (!pluginResult.success) {
        return finalizeFailure(
          workflowRunId,
          step,
          buildFailedResult(step.id, {
            pluginResult,
            error: new Error(pluginResult.message ?? `插件 ${step.plugin} 执行失败`),
            failureKind: pluginFailureKind(pluginResult),
          }),
          context,
          meta,
        );
      }

      const executionResult = buildCompletedResult(step.id, pluginResult);
      await notifyStepComplete(workflowRunId, step, executionResult, context, meta);
      return executionResult;
    } catch (error) {
      if (error instanceof ResourceQueueCancelledError) {
        const executionResult = buildSkippedResult(step.id, resolveQueueSkipReason(handle));
        await notifyStepComplete(workflowRunId, step, executionResult, context, meta);
        return executionResult;
      }

      const err = error instanceof Error ? error : new Error(String(error));
      const failureKind =
        error instanceof StepExecutionError ? error.kind : StepFailureKinds.INTERNAL;

      return finalizeFailure(
        workflowRunId,
        step,
        buildFailedResult(step.id, {
          error: err,
          failureKind,
        }),
        context,
        meta,
      );
    }
  }

  function buildStepContext(
    step: WorkflowStep,
    workflowId: string,
    runContext: Partial<ExecutionContext>,
  ): ExecutionContext {
    return {
      ...runContext,
      workflowId,
      stepId: step.id,
    } as ExecutionContext;
  }

  async function propagateDependents(
    workflowRunId: string,
    stepId: string,
    graph: DagGraph,
    results: Map<string, ExecutionResult>,
    inDegree: Map<string, number>,
    ready: string[],
    workflowId: string,
    runContext: Partial<ExecutionContext>,
    meta: WorkflowRunMeta,
  ): Promise<void> {
    for (const dependentId of graph.dependents.get(stepId) ?? []) {
      if (results.has(dependentId)) continue;

      const nextDegree = (inDegree.get(dependentId) ?? 0) - 1;
      inDegree.set(dependentId, nextDegree);

      if (nextDegree > 0) continue;

      const dependent = graph.stepById.get(dependentId)!;

      if (!allDependenciesSucceeded(dependent, results)) {
        const skipped = buildSkippedResult(dependentId, SkipReasons.DEPENDENCY_FAILED);
        results.set(dependentId, skipped);
        await notifyStepComplete(
          workflowRunId,
          dependent,
          skipped,
          buildStepContext(dependent, workflowId, runContext),
          meta,
        );
        await propagateDependents(
          workflowRunId,
          dependentId,
          graph,
          results,
          inDegree,
          ready,
          workflowId,
          runContext,
          meta,
        );
        continue;
      }

      ready.push(dependentId);
    }
  }

  async function maybeEmitPaused(
    workflowRunId: string,
    handle: RunHandle,
    meta: WorkflowRunMeta,
  ): Promise<void> {
    const wasPausing = handle.isPausing();
    handle.checkPausingToPaused();
    if (wasPausing && handle.isPaused()) {
      await emit(
        buildEvent(workflowRunId, {
          type: WorkflowEventTypes.WORKFLOW_PAUSED,
          meta,
          inFlightSteps: handle.getInFlightSteps(),
        }),
      );
    }
  }

  /**
   * 执行工作流
   */
  async function executeWorkflow(
    workflowRunId: string,
    workflow: WorkflowDefinition,
    context: Partial<ExecutionContext> = {},
  ): Promise<WorkflowRunResult> {
    assertValidWorkflowRunId(workflowRunId);
    const handle = registry.register(workflowRunId);
    handle.setTotalSteps(workflow.steps.length);

    try {
      const graph = validateDag(workflow.steps);
      const cleanContext = stripCallerRunId(context);
      const runMeta = buildRunMeta(workflow.id, cleanContext);
      handle.setRunMeta(runMeta);
      const traceId = runMeta.traceId;
      const runContext: Partial<ExecutionContext> = {
        ...cleanContext,
        runId: workflowRunId,
        ...(traceId !== undefined ? { traceId } : {}),
      };

      await emit(
        buildEvent(workflowRunId, {
          type: WorkflowEventTypes.WORKFLOW_START,
          meta: runMeta,
          workflow,
        }),
      );

      const results = new Map<string, ExecutionResult>();
      const inDegree = new Map(graph.inDegree);
      const ready: string[] = [];

      for (const [id, degree] of inDegree) {
        if (degree === 0) ready.push(id);
      }

      const inFlight = new Map<string, Promise<void>>();
      let workflowFailed = false;
      let workflowAborted = false;

      const runStep = async (stepId: string) => {
        const step = graph.stepById.get(stepId)!;
        const signal = handle.trackInFlight(stepId);
        try {
          const executionContext: ExecutionContext = {
            ...runContext,
            workflowId: workflow.id,
            stepId: step.id,
            previousResults: toPreviousResults(results),
          };

          const result = await executeStep(
            workflowRunId,
            step,
            executionContext,
            runMeta,
            signal,
            handle,
          );
          results.set(stepId, result);

          if (result.status === StepStatuses.FAILED) {
            workflowFailed = true;
          }

          await propagateDependents(
            workflowRunId,
            stepId,
            graph,
            results,
            inDegree,
            ready,
            workflow.id,
            runContext,
            runMeta,
          );
        } finally {
          handle.untrackInFlight(stepId);
          handle.incrementCompleted();
          await maybeEmitPaused(workflowRunId, handle, runMeta);
        }
      };

      while (ready.length > 0 || inFlight.size > 0) {
        if (workflowFailed && failFast) {
          handle.setFailFastAbort();
        }

        const stopScheduling = handle.shouldStopScheduling() || (workflowFailed && failFast);

        if (stopScheduling && !workflowAborted) {
          workflowAborted = true;
          onWorkflowAbort?.(workflowRunId);
          ready.length = 0;
        }

        if (handle.isPaused() || handle.isPausing()) {
          if (handle.isPaused()) {
            await handle.waitUntilResumed();
          }
          if (inFlight.size === 0 && handle.isPausing()) {
            await maybeEmitPaused(workflowRunId, handle, runMeta);
          }
          if (inFlight.size === 0) continue;
        }

        while (
          ready.length > 0 &&
          inFlight.size < maxParallelSteps &&
          !stopScheduling &&
          !handle.isPaused() &&
          !handle.isPausing()
        ) {
          const stepId = ready.shift()!;
          if (results.has(stepId)) continue;

          const task = runStep(stepId).finally(() => {
            inFlight.delete(stepId);
          });
          inFlight.set(stepId, task);
        }

        if (inFlight.size === 0) {
          if (handle.isPaused() || handle.isPausing()) continue;
          break;
        }

        await Promise.race(inFlight.values());
      }

      if (handle.shouldStopScheduling()) {
        const skipReason = resolveAbortSkipReason(handle.getAbortReason());
        for (const step of workflow.steps) {
          if (!results.has(step.id)) {
            const skipped = buildSkippedResult(step.id, skipReason);
            results.set(step.id, skipped);
            await notifyStepComplete(
              workflowRunId,
              step,
              skipped,
              buildStepContext(step, workflow.id, runContext),
              runMeta,
            );
          }
        }
      } else if (!failFast) {
        for (const step of workflow.steps) {
          if (!results.has(step.id)) {
            const skipped = buildSkippedResult(step.id, SkipReasons.DEPENDENCY_FAILED);
            results.set(step.id, skipped);
            await notifyStepComplete(
              workflowRunId,
              step,
              skipped,
              buildStepContext(step, workflow.id, runContext),
              runMeta,
            );
          }
        }
      }

      const finalResults = workflow.steps
        .map((s) => results.get(s.id))
        .filter((r): r is ExecutionResult => r !== undefined);

      executionHistory.set(workflow.id, finalResults);

      const runResult = buildWorkflowRunResult(workflow.id, finalResults, handle);
      handle.setTerminalStatus(runResult.status === 'success' ? 'finished' : runResult.status);

      await emit(
        buildEvent(workflowRunId, {
          type: WorkflowEventTypes.WORKFLOW_FINISHED,
          meta: runMeta,
          result: runResult,
        }),
      );

      return runResult;
    } finally {
      registry.unregister(workflowRunId);
    }
  }

  async function cancelRun(
    workflowRunId: string,
    options: CancelRunOptions = {},
  ): Promise<RunControlResult> {
    const handle = registry.get(workflowRunId);
    if (!handle) {
      const cached = registry.getStatus(workflowRunId);
      return {
        workflowRunId,
        action: 'cancel',
        previousStatus: cached?.status ?? 'unknown',
        currentStatus: cached?.status ?? 'unknown',
        mode: options.mode ?? 'best-effort',
      };
    }

    const previousStatus = handle.getStatus();
    const result = await handle.requestCancel(options);

    if (
      result.currentStatus === 'cancelling' &&
      previousStatus !== 'cancelling' &&
      previousStatus !== 'cancelled'
    ) {
      const meta = handle.getRunMeta();
      if (meta) {
        await emit(
          buildEvent(workflowRunId, {
            type: WorkflowEventTypes.WORKFLOW_CANCELLED,
            meta,
            inFlightSteps: result.inFlightSteps ?? [],
            mode: result.mode ?? 'best-effort',
          }),
        );
      }
      onWorkflowAbort?.(workflowRunId);
    }

    return {
      ...result,
      currentStatus: handle.getStatus(),
    };
  }

  async function pauseRun(
    workflowRunId: string,
    options: PauseRunOptions = {},
  ): Promise<RunControlResult> {
    const handle = registry.get(workflowRunId);
    if (!handle) {
      const cached = registry.getStatus(workflowRunId);
      return {
        workflowRunId,
        action: 'pause',
        previousStatus: cached?.status ?? 'unknown',
        currentStatus: cached?.status ?? 'unknown',
      };
    }

    const result = await handle.requestPause(options);

    if (result.currentStatus === 'pausing' && (options.waitInFlight ?? true)) {
      await handle.waitForPaused();
    } else if (result.currentStatus === 'paused') {
      const meta = handle.getRunMeta();
      if (meta) {
        await emit(
          buildEvent(workflowRunId, {
            type: WorkflowEventTypes.WORKFLOW_PAUSED,
            meta,
            inFlightSteps: result.inFlightSteps ?? [],
          }),
        );
      }
    }

    return { ...result, currentStatus: handle.getStatus() };
  }

  async function resumeRun(workflowRunId: string): Promise<RunControlResult> {
    const handle = registry.get(workflowRunId);
    if (!handle) {
      const cached = registry.getStatus(workflowRunId);
      return {
        workflowRunId,
        action: 'resume',
        previousStatus: cached?.status ?? 'unknown',
        currentStatus: cached?.status ?? 'unknown',
      };
    }

    const result = await handle.requestResume();
    if (result.currentStatus === 'running' && result.previousStatus === 'paused') {
      const meta = handle.getRunMeta();
      if (meta) {
        await emit(
          buildEvent(workflowRunId, {
            type: WorkflowEventTypes.WORKFLOW_RESUMED,
            meta,
          }),
        );
      }
    }

    return result;
  }

  function getRunStatus(workflowRunId: string): RunStatusSnapshot | undefined {
    return registry.getStatus(workflowRunId);
  }

  async function destroyActiveRuns(): Promise<void> {
    for (const handle of registry.getAllActive()) {
      onWorkflowAbort?.(handle.workflowRunId);
    }
    await registry.destroyAll();
  }

  function getExecutionHistory(workflowId: string): ExecutionResult[] | undefined {
    return executionHistory.get(workflowId);
  }

  function clearHistory(): void {
    executionHistory.clear();
  }

  return {
    executeWorkflow,
    executeStep,
    getExecutionHistory,
    clearHistory,
    cancelRun,
    pauseRun,
    resumeRun,
    getRunStatus,
    destroyActiveRuns,
  };
}

export const createExecutor = createWorkflowExecutor;
