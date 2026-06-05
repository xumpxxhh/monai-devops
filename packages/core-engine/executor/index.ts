/**
 * 流程执行器
 * @module executor
 */

import { randomUUID } from "node:crypto";
import type { PluginResult } from "@monai-devops/plugin-sdk";
import {
  StepExecutionError,
  SkipReasons,
  StepFailureKinds,
  StepStatuses,
  WorkflowValidationError,
} from "../errors.js";
import type { WorkflowLifecycleEvent, WorkflowRunMeta } from "../observer/index.js";
import {
  buildCompletedResult,
  buildFailedResult,
  buildSkippedResult,
  pluginFailureKind,
} from "./helpers.js";
import type {
  ExecutionContext,
  ExecutionResult,
  ExecutorOptions,
  StepCondition,
  WorkflowDefinition,
  WorkflowRunResult,
  WorkflowStep,
} from "./types.js";

export type {
  ExecutionContext,
  ExecutionResult,
  ExecutorOptions,
  PluginExecutor,
  StepCondition,
  WorkflowDefinition,
  WorkflowRunResult,
  WorkflowStep,
} from "./types.js";

export { WorkflowValidationError } from "../errors.js";

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
        throw new WorkflowValidationError(
          `步骤 ${step.id} 依赖不存在的步骤: ${depId}`,
        );
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
    throw new WorkflowValidationError("工作流存在循环依赖");
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

function toPreviousResults(
  results: Map<string, ExecutionResult>,
): Record<string, unknown> {
  const acc: Record<string, unknown> = {};
  for (const [stepId, r] of results) {
    if (r.status !== StepStatuses.FAILED) {
      acc[stepId] = r.result;
    }
  }
  return acc;
}

function buildRunMeta(
  workflowId: string,
  context: Partial<ExecutionContext>,
): WorkflowRunMeta {
  const runId =
    typeof context.runId === "string" && context.runId.length > 0
      ? context.runId
      : randomUUID();
  const traceId =
    typeof context.traceId === "string" && context.traceId.length > 0
      ? context.traceId
      : undefined;

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
  } = options;

  const executionHistory: Map<string, ExecutionResult[]> = new Map();

  async function emit(event: WorkflowLifecycleEvent): Promise<void> {
    await observer?.onEvent?.(event);
  }

  async function notifyStepComplete(
    step: WorkflowStep,
    executionResult: ExecutionResult,
    meta: WorkflowRunMeta | undefined,
  ): Promise<void> {
    onStepComplete?.(step, executionResult);
    if (meta) {
      await emit({
        type: "step:finished",
        meta,
        step,
        result: executionResult,
      });
    }
  }

  async function finalizeFailure(
    step: WorkflowStep,
    executionResult: ExecutionResult,
    meta: WorkflowRunMeta | undefined,
  ): Promise<ExecutionResult> {
    if (executionResult.error) {
      onStepError?.(step, executionResult.error);
    }
    await notifyStepComplete(step, executionResult, meta);
    return executionResult;
  }

  async function executeStep(
    step: WorkflowStep,
    context: ExecutionContext,
    meta?: WorkflowRunMeta,
  ): Promise<ExecutionResult> {
    if (!checkCondition(step.condition, context.previousResults ?? {})) {
      const executionResult = buildSkippedResult(
        step.id,
        SkipReasons.CONDITION_NOT_MET,
      );
      await notifyStepComplete(step, executionResult, meta);
      return executionResult;
    }

    try {
      onStepStart?.(step);
      if (meta) {
        await emit({ type: "step:start", meta, step });
      }

      let pluginResult: PluginResult;

      if (pluginExecutor) {
        pluginResult = await pluginExecutor(step.plugin, step.config, context);
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
            error: new Error(
              pluginResult.message ?? `插件 ${step.plugin} 执行失败`,
            ),
            failureKind: pluginFailureKind(pluginResult),
          }),
          meta,
        );
      }

      const executionResult = buildCompletedResult(step.id, pluginResult);
      await notifyStepComplete(step, executionResult, meta);
      return executionResult;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const failureKind =
        error instanceof StepExecutionError
          ? error.kind
          : StepFailureKinds.INTERNAL;

      return finalizeFailure(
        step,
        buildFailedResult(step.id, {
          error: err,
          failureKind,
        }),
        meta,
      );
    }
  }

  async function propagateDependents(
    stepId: string,
    graph: DagGraph,
    results: Map<string, ExecutionResult>,
    inDegree: Map<string, number>,
    ready: string[],
    meta: WorkflowRunMeta,
  ): Promise<void> {
    for (const dependentId of graph.dependents.get(stepId) ?? []) {
      if (results.has(dependentId)) continue;

      const nextDegree = (inDegree.get(dependentId) ?? 0) - 1;
      inDegree.set(dependentId, nextDegree);

      if (nextDegree > 0) continue;

      const dependent = graph.stepById.get(dependentId)!;

      if (!allDependenciesSucceeded(dependent, results)) {
        const skipped = buildSkippedResult(
          dependentId,
          SkipReasons.DEPENDENCY_FAILED,
        );
        results.set(dependentId, skipped);
        await notifyStepComplete(dependent, skipped, meta);
        await propagateDependents(
          dependentId,
          graph,
          results,
          inDegree,
          ready,
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

    await emit({ type: "workflow:start", meta: runMeta, workflow });

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
        runMeta,
      );
    };

    while (ready.length > 0 || inFlight.size > 0) {
      if (workflowFailed && failFast) {
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
          const skipped = buildSkippedResult(
            step.id,
            SkipReasons.WORKFLOW_ABORTED,
          );
          results.set(step.id, skipped);
          await notifyStepComplete(step, skipped, runMeta);
        }
      }
    } else {
      for (const step of workflow.steps) {
        if (!results.has(step.id)) {
          const skipped = buildSkippedResult(
            step.id,
            SkipReasons.DEPENDENCY_FAILED,
          );
          results.set(step.id, skipped);
          await notifyStepComplete(step, skipped, runMeta);
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
      type: "workflow:finished",
      meta: runMeta,
      result: runResult,
    });

    return runResult;
  }

  function getExecutionHistory(
    workflowId: string,
  ): ExecutionResult[] | undefined {
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
