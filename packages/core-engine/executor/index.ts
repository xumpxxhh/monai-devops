/**
 * 流程执行器
 * @module executor
 */

import { randomUUID } from 'node:crypto';
import { noopLogger, PluginContextKeys, type PluginResult } from '@monai-devops/plugin-sdk';
import {
  ResourceQueueCancelledError,
  StepExecutionError,
  SkipReasons,
  StepFailureKinds,
  StepStatuses,
  WorkflowValidationError,
} from '../errors.js';
import type { WorkflowLifecycleEvent, WorkflowRunMeta } from '../observer/index.js';
import { createContextLogger } from '../plugin/create-context-logger.js';
import {
  buildCompletedResult,
  buildFailedResult,
  buildSkippedResult,
  pluginFailureKind,
} from './helpers.js';
import type {
  ExecutionContext,
  ExecutionResult,
  ExecutorOptions,
  StepCondition,
  WorkflowDefinition,
  WorkflowRunResult,
  WorkflowStep,
} from './types.js';

export type {
  ExecutionContext,
  ExecutionResult,
  ExecutorOptions,
  PluginExecutor,
  StepCondition,
  WorkflowDefinition,
  WorkflowRunResult,
  WorkflowStep,
} from './types.js';

export { WorkflowValidationError } from '../errors.js';

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

function buildRunMeta(workflowId: string, context: Partial<ExecutionContext>): WorkflowRunMeta {
  const runId =
    typeof context.runId === 'string' && context.runId.length > 0 ? context.runId : randomUUID();
  const traceId =
    typeof context.traceId === 'string' && context.traceId.length > 0 ? context.traceId : undefined;

  return {
    runId,
    workflowId,
    traceId,
    context,
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
  } = options;

  const executionHistory: Map<string, ExecutionResult[]> = new Map();

  async function emit(event: WorkflowLifecycleEvent): Promise<void> {
    await observer?.onEvent?.(event);
  }

  async function notifyStepComplete(
    step: WorkflowStep,
    executionResult: ExecutionResult,
    context: ExecutionContext,
    meta: WorkflowRunMeta | undefined,
  ): Promise<void> {
    onStepComplete?.(step, executionResult, context);
    if (meta) {
      await emit({
        type: 'step:finished',
        meta,
        step,
        result: executionResult,
      });
    }
  }

  async function finalizeFailure(
    step: WorkflowStep,
    executionResult: ExecutionResult,
    context: ExecutionContext,
    meta: WorkflowRunMeta | undefined,
  ): Promise<ExecutionResult> {
    if (executionResult.error) {
      onStepError?.(step, executionResult.error, context);
    }
    await notifyStepComplete(step, executionResult, context, meta);
    return executionResult;
  }

  async function executeStep(
    step: WorkflowStep,
    context: ExecutionContext,
    meta?: WorkflowRunMeta,
  ): Promise<ExecutionResult> {
    if (!checkCondition(step.condition, context.previousResults ?? {})) {
      const executionResult = buildSkippedResult(step.id, SkipReasons.CONDITION_NOT_MET);
      await notifyStepComplete(step, executionResult, context, meta);
      return executionResult;
    }

    try {
      await onStepStart?.(step, context, meta);
      if (meta) {
        await emit({ type: 'step:start', meta, step });
      }

      let pluginResult: PluginResult;

      if (pluginExecutor) {
        let flushLogs: (() => Promise<void>) | undefined;
        let pluginContext = context as typeof context & Record<string, unknown>;

        if (meta) {
          const { logger, flush } = createContextLogger({
            emit: (log) => emit({ type: 'plugin:log', meta, step, log }),
          });
          flushLogs = flush;
          pluginContext = { ...context, [PluginContextKeys.logger]: logger };
        } else {
          pluginContext = { ...context, [PluginContextKeys.logger]: noopLogger };
        }

        pluginResult = await pluginExecutor(step.plugin, step.config, pluginContext);
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
      await notifyStepComplete(step, executionResult, context, meta);
      return executionResult;
    } catch (error) {
      if (error instanceof ResourceQueueCancelledError) {
        const executionResult = buildSkippedResult(step.id, SkipReasons.WORKFLOW_ABORTED);
        await notifyStepComplete(step, executionResult, context, meta);
        return executionResult;
      }

      const err = error instanceof Error ? error : new Error(String(error));
      const failureKind =
        error instanceof StepExecutionError ? error.kind : StepFailureKinds.INTERNAL;

      return finalizeFailure(
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
          dependent,
          skipped,
          buildStepContext(dependent, workflowId, runContext),
          meta,
        );
        await propagateDependents(
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

  /**
   * 执行工作流
   */
  async function executeWorkflow(
    workflow: WorkflowDefinition,
    context: Partial<ExecutionContext> = {},
  ): Promise<WorkflowRunResult> {
    const graph = validateDag(workflow.steps);
    const runMeta = buildRunMeta(workflow.id, context);
    const runContext: Partial<ExecutionContext> = {
      ...context,
      runId: runMeta.runId,
      ...(runMeta.traceId !== undefined ? { traceId: runMeta.traceId } : {}),
    };

    await emit({ type: 'workflow:start', meta: runMeta, workflow });

    const results = new Map<string, ExecutionResult>();
    const inDegree = new Map(graph.inDegree);
    const ready: string[] = [];

    for (const [id, degree] of inDegree) {
      if (degree === 0) ready.push(id);
    }

    const inFlight = new Map<string, Promise<void>>();
    let workflowFailed = false;

    const runStep = async (stepId: string) => {
      const step = graph.stepById.get(stepId)!;
      const executionContext: ExecutionContext = {
        ...runContext,
        workflowId: workflow.id,
        stepId: step.id,
        previousResults: toPreviousResults(results),
      };

      const result = await executeStep(step, executionContext, runMeta);
      results.set(stepId, result);

      if (result.status === StepStatuses.FAILED) {
        workflowFailed = true;
      }

      await propagateDependents(
        stepId,
        graph,
        results,
        inDegree,
        ready,
        workflow.id,
        runContext,
        runMeta,
      );
    };

    let workflowAborted = false;

    while (ready.length > 0 || inFlight.size > 0) {
      if (workflowFailed && failFast) {
        if (!workflowAborted) {
          workflowAborted = true;
          onWorkflowAbort?.(runMeta.runId);
        }
        ready.length = 0;
      }

      while (
        ready.length > 0 &&
        inFlight.size < maxParallelSteps &&
        !(workflowFailed && failFast)
      ) {
        const stepId = ready.shift()!;
        if (results.has(stepId)) continue;

        const task = runStep(stepId).finally(() => {
          inFlight.delete(stepId);
        });
        inFlight.set(stepId, task);
      }

      if (inFlight.size === 0) break;

      await Promise.race(inFlight.values());
    }

    if (failFast) {
      for (const step of workflow.steps) {
        if (!results.has(step.id)) {
          const skipped = buildSkippedResult(step.id, SkipReasons.WORKFLOW_ABORTED);
          results.set(step.id, skipped);
          await notifyStepComplete(
            step,
            skipped,
            buildStepContext(step, workflow.id, runContext),
            runMeta,
          );
        }
      }
    } else {
      for (const step of workflow.steps) {
        if (!results.has(step.id)) {
          const skipped = buildSkippedResult(step.id, SkipReasons.DEPENDENCY_FAILED);
          results.set(step.id, skipped);
          await notifyStepComplete(
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

    const runResult: WorkflowRunResult = {
      success: finalResults.every((r) => r.status !== StepStatuses.FAILED),
      workflowId: workflow.id,
      results: finalResults,
    };

    await emit({
      type: 'workflow:finished',
      meta: runMeta,
      result: runResult,
    });

    return runResult;
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
  };
}

export const createExecutor = createWorkflowExecutor;
