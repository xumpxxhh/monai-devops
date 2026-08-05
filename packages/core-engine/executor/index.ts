/**
 * 流程执行器：DAG 校验、并行调度、单步执行、Run 生命周期控制。
 *
 * 职责边界：
 * - 编排层（本模块）：依赖图、条件分支、failFast、取消/暂停、观察者事件
 * - 插件层（plugin-sdk）：execute 契约与 PluginResult，永不 throw
 * - 引擎层（engine）：资源分配钩子 onStepStart/onStepComplete
 *
 * 调度模型：基于 Kahn 拓扑的 ready 队列 + inFlight 池（上限 maxParallelSteps），
 * 用 Promise.race 驱动直至无就绪步骤且无 in-flight 或进入暂停态。
 *
 * @module executor
 */

import {
  noopLogger,
  PluginCancelledError,
  PluginContextKeys,
  PluginFailureCodes,
  type PluginResult,
} from '@monai-devops/plugin-sdk';
import {
  ResourceQueueCancelledError,
  StepExecutionError,
  SkipReasons,
  StepFailureKinds,
  StepStatuses,
  WorkflowRunIdValidationError,
  WorkflowValidationError,
} from '../errors.js';
import type { SkipReason } from '../errors.js';
import type {
  WorkflowEventParent,
  WorkflowLifecycleEvent,
  WorkflowRunMeta,
} from '../observer/index.js';
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
import { resolveConfigReferences, validateWorkflowContextReferences } from './context-reference.js';
import type {
  AbortSchedulingReason,
  CancelRunOptions,
  EmbeddedRunHooks,
  ExecutionContext,
  ExecutionResult,
  ExecuteWorkflowCallOptions,
  ExecutorOptions,
  JsonSchemaObject,
  PauseRunOptions,
  ResolveWorkflow,
  RunControlResult,
  RunStatusSnapshot,
  StateCondition,
  StepCondition,
  WorkflowDefinition,
  WorkflowRunResult,
  WorkflowRunStatus,
  WorkflowStep,
  StepCompleteOptions,
  WorkflowRefStep,
} from './types.js';
import {
  getStepKind,
  isPluginStep,
  isSetStateStep,
  isWorkflowRefStep,
  StepKinds,
} from './types.js';
import { deriveChildRunId } from './child-run-id.js';
import { defaultStateFromSchema, parseState } from './state-schema.js';
import { validateStepKinds } from './step-kind-validation.js';

export type {
  AbortSchedulingReason,
  CancelRunOptions,
  EmbeddedRunHooks,
  ExecutionContext,
  ExecutionResult,
  ExecuteWorkflowCallOptions,
  ExecutorOptions,
  JsonSchemaObject,
  PauseRunOptions,
  PluginExecutor,
  PluginStep,
  ResolveWorkflow,
  RunControlMode,
  RunControlResult,
  RunControlStatus,
  RunStatusSnapshot,
  SetStateStep,
  StateCondition,
  StepCompleteOptions,
  StepCondition,
  StepKind,
  WorkflowDefinition,
  WorkflowRefStep,
  WorkflowRunResult,
  WorkflowRunStatus,
  WorkflowStep,
} from './types.js';

export {
  getStepKind,
  isPluginStep,
  isSetStateStep,
  isWorkflowRefStep,
  StepKinds,
} from './types.js';

export type {
  ContextRef,
  ResolveConfigReferencesOptions,
  ValidateWorkflowContextReferencesOptions,
} from './context-reference.js';
export {
  WORKFLOW_STATE_REF_ID,
  extractContextReferences,
  getAncestorIds,
  getValueByPath,
  isContextRef,
  isWorkflowStateRef,
  resolveConfigReferences,
  resolveStepResultSchema,
  validateWorkflowContextReferences,
} from './context-reference.js';

export type { StepKindDefinition } from './builtin-step-kinds.js';
export {
  BUILTIN_STEP_KIND_DEFINITIONS,
  SET_STATE_RESULT_SCHEMA,
  WORKFLOW_REF_RESULT_SCHEMA,
} from './builtin-step-kinds.js';

export {
  StateSchemaConversionError,
  defaultStateFromSchema,
  jsonSchemaToZod,
  parseState,
} from './state-schema.js';

export { deriveChildRunId, shortHash } from './child-run-id.js';
export { getStepReferencePayload, validateStepKinds } from './step-kind-validation.js';
export {
  validateWorkflowNesting,
  type ValidateWorkflowNestingOptions,
} from './workflow-nesting.js';

export type {
  WorkflowEventParent,
  WorkflowIterationChildResultSummary,
  WorkflowLifecycleEvent,
  WorkflowRunMeta,
} from '../observer/index.js';

export { RunHandle } from './run-handle.js';
export { RunRegistry } from './run-registry.js';
export {
  RunAlreadyActiveError,
  WorkflowRunIdValidationError,
  WorkflowValidationError,
} from '../errors.js';

/** 单次 run 内可变的 state 容器 */
interface RunStateBag {
  current: unknown;
  schema: JsonSchemaObject;
}

/** 步骤执行时携带的 run 级能力（state / 子工作流解析等） */
interface StepRuntime {
  runState?: RunStateBag;
  resolveWorkflow?: ResolveWorkflow;
  embeddedRunHooks?: EmbeddedRunHooks;
  nestingDepth: number;
  ancestorWorkflowIds: string[];
}

const WORKFLOW_RUN_ID_MAX_LENGTH = 128;
/** 允许字母、数字、下划线、连字符；拒绝首尾空白后校验主体字符集 */
const WORKFLOW_RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * 启动前校验 workflowRunId。非法时抛 WorkflowRunIdValidationError，不发出 workflow:start。
 * 同一 id 的并发活跃 Run 由 RunRegistry 在 register 时拦截。
 */
export function assertValidWorkflowRunId(id: unknown): asserts id is string {
  if (typeof id !== 'string') {
    throw new WorkflowRunIdValidationError('workflowRunId 必须为字符串');
  }

  const trimmed = id.trim();
  if (trimmed.length === 0) {
    throw new WorkflowRunIdValidationError('workflowRunId 不能为空');
  }

  if (id !== trimmed) {
    throw new WorkflowRunIdValidationError('workflowRunId 不能含首尾空白');
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

/** 内存中的 DAG 邻接表：入度、下游列表、步骤索引 */
export interface DagGraph {
  stepIds: Set<string>;
  inDegree: Map<string, number>;
  dependents: Map<string, string[]>;
  stepById: Map<string, WorkflowStep>;
}

/**
 * 从步骤列表构建 DAG 结构。仅做结构校验（重复 id、悬空 dependsOn），不检测环。
 * 环检测由 validateDag 通过 Kahn 算法完成。
 */
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

/**
 * 构建并校验 DAG 无环。visited !== stepIds.size 表示存在环，抛 WorkflowValidationError。
 * 导出供 apps/server / apps/web 复用（§0 决策 25）。
 */
export function validateDag(steps: WorkflowStep[]): DagGraph {
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

/**
 * 求值结构化步骤条件（基于 previousResults[when] 或 state[when]）。
 * 优先级：exists → equals → 默认「值非 null/undefined 即通过」。
 */
function checkCondition(
  condition: StepCondition | StateCondition | undefined,
  source: Record<string, unknown>,
): boolean {
  if (!condition) return true;

  const value = source[condition.when];

  if (condition.exists !== undefined) {
    const exists = value !== undefined && value !== null;
    return condition.exists ? exists : !exists;
  }

  if (condition.equals !== undefined) {
    return value === condition.equals;
  }

  return value !== undefined && value !== null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/** 依赖步骤均已完成且非 FAILED（SKIPPED/COMPLETED 视为可继续下游） */
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

/**
 * 将已完成步骤结果转为插件可见的 previousResults。
 * FAILED 步骤不写入 map，下游 condition 无法读取其 result。
 */
function toPreviousResults(results: Map<string, ExecutionResult>): Record<string, unknown> {
  const acc: Record<string, unknown> = {};
  for (const [stepId, r] of results) {
    if (r.status !== StepStatuses.FAILED) {
      acc[stepId] = r.result;
    }
  }
  return acc;
}

/**
 * 仅收录 COMPLETED 且 pluginResult.success 的 data，供 config $ref 解析。
 * SKIPPED / FAILED / data === undefined 均不写入（用 key 是否存在表达可注入性）。
 */
export function toPreviousResultsData(
  results: Map<string, ExecutionResult>,
): Record<string, unknown> {
  const acc: Record<string, unknown> = {};
  for (const [stepId, r] of results) {
    if (
      r.status === StepStatuses.COMPLETED &&
      r.pluginResult?.success === true &&
      r.pluginResult.data !== undefined
    ) {
      acc[stepId] = r.pluginResult.data;
    }
  }
  return acc;
}

/** 剥离调用方传入的 runId，避免覆盖内核注入的 workflowRunId */
function stripCallerRunId(context: Partial<ExecutionContext>): Partial<ExecutionContext> {
  const { runId, ...rest } = context;
  void runId;
  return rest;
}

/** 构造观察者事件共用的 WorkflowRunMeta（不含 runId，runId 在事件顶层） */
function buildRunMeta(workflowId: string, context: Partial<ExecutionContext>): WorkflowRunMeta {
  const traceId =
    typeof context.traceId === 'string' && context.traceId.length > 0 ? context.traceId : undefined;

  return {
    workflowId,
    traceId,
    context: stripCallerRunId(context),
  };
}

/** 为生命周期事件补上顶层 workflowRunId 字段 */
function buildEvent(
  workflowRunId: string,
  event: { type: WorkflowLifecycleEvent['type'] } & Record<string, unknown>,
): WorkflowLifecycleEvent {
  return { ...event, workflowRunId } as WorkflowLifecycleEvent;
}

/**
 * 将 Run 中止原因映射为未执行/排队步骤的 skipReason。
 * fail_fast → WORKFLOW_ABORTED；用户取消/destroy → USER_CANCELLED。
 */
function resolveAbortSkipReason(reason: AbortSchedulingReason): SkipReason {
  if (reason === 'fail_fast') return SkipReasons.WORKFLOW_ABORTED;
  if (reason === 'user_cancel' || reason === 'destroy') return SkipReasons.USER_CANCELLED;
  return SkipReasons.WORKFLOW_ABORTED;
}

/**
 * 在 hard cancel / pause+abortInFlight 场景下，将插件执行与 AbortSignal 赛跑。
 *
 * - 无 signal：直接 await 插件，返回 completed。
 * - signal 触发 abort 后启动 inFlightTimeoutMs 计时；超时则返回 timeout + pluginSettled，
 *   调用方用 pluginSettled 推迟资源释放（插件可能仍在后台运行）。
 * - 若在超时前插件先结束：返回 completed；超时后完成的插件结果会被忽略（raceDecided）。
 */
async function racePluginWithInFlightAbort(
  execute: () => Promise<PluginResult>,
  signal: AbortSignal | undefined,
  isInFlightAbortActive: () => boolean,
  timeoutMs: number,
): Promise<
  | { outcome: 'completed'; result: PluginResult }
  | { outcome: 'timeout'; pluginSettled: Promise<void> }
> {
  if (!signal) {
    return { outcome: 'completed', result: await execute() };
  }

  let raceDecided = false;
  const pluginPromise = execute();
  // 无论成功/失败，供超时路径等待插件真正结束后再释放资源
  const pluginSettled = pluginPromise.then(
    () => undefined,
    () => undefined,
  );

  return new Promise((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      signal.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      if (!isInFlightAbortActive()) return;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        cleanup();
        if (!raceDecided) {
          raceDecided = true;
          resolve({ outcome: 'timeout', pluginSettled });
        }
      }, timeoutMs);
    };

    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort);
    }

    pluginPromise.then(
      (result) => {
        if (raceDecided) return; // 已按超时收尾，忽略迟到的插件结果
        raceDecided = true;
        cleanup();
        resolve({ outcome: 'completed', result });
      },
      (error: unknown) => {
        if (raceDecided) return;
        raceDecided = true;
        cleanup();
        reject(error);
      },
    );
  });
}

/**
 * 汇总整次 Run 的最终状态。
 * cancelled 仅当 abortReason 为 user_cancel/destroy；failFast 导致的中止仍为 failed/success。
 */
function buildWorkflowRunResult(
  workflowId: string,
  finalResults: ExecutionResult[],
  handle: RunHandle,
  state?: unknown,
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
    ...(state !== undefined ? { state } : {}),
  };
}

/**
 * 创建流程执行器实例。
 *
 * 每个 workflowRunId 对应一个 RunHandle（RunRegistry 管理），支持 cancel/pause/resume。
 * executionHistory 按 workflowRunId 键存储最近一次该 run 的步骤结果。
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
    resolvePluginResultSchema,
    resolveWorkflow: defaultResolveWorkflow,
    embeddedRunHooks: defaultEmbeddedRunHooks,
    maxNestingDepth = 3,
  } = options;

  const executionHistory: Map<string, ExecutionResult[]> = new Map();
  const registry = new RunRegistry();
  /** 子 run id → 父挂靠信息；emit 时统一注入 parent */
  const eventParents = new Map<string, WorkflowEventParent>();

  /** 向 WorkflowObserver 派发事件；onEvent 支持 async，此处 await 保证顺序 */
  async function emit(event: WorkflowLifecycleEvent): Promise<void> {
    const parent = eventParents.get(event.workflowRunId);
    const enriched = parent && event.parent === undefined ? { ...event, parent } : event;
    await observer?.onEvent?.(enriched as WorkflowLifecycleEvent);
  }

  /**
   * 步骤结束统一出口：先 onStepComplete（含资源释放），再 step:finished 事件。
   * completeOptions.deferReleaseUntil 供 in-flight 超时场景推迟引擎侧资源归还。
   */
  async function notifyStepComplete(
    workflowRunId: string,
    step: WorkflowStep,
    executionResult: ExecutionResult,
    context: ExecutionContext,
    meta: WorkflowRunMeta | undefined,
    completeOptions?: StepCompleteOptions,
  ): Promise<void> {
    onStepComplete?.(step, executionResult, context, completeOptions);
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

  /** 失败步骤：onStepError → notifyStepComplete（仍发 step:finished，无单独 error 事件） */
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

  /** 资源队列被取消（failFast/onWorkflowAbort）时的 skipReason */
  function resolveQueueSkipReason(handle: RunHandle | undefined): SkipReason {
    if (!handle) return SkipReasons.WORKFLOW_ABORTED;
    return resolveAbortSkipReason(handle.getAbortReason());
  }

  /** in-flight 被中断时的 skipReason；pause+abortInFlight 优先于 cancel/failFast */
  function resolveInFlightAbortSkipReason(handle: RunHandle | undefined): SkipReason {
    if (handle?.isPauseAbortInFlight()) {
      return SkipReasons.PAUSE_INTERRUPTED;
    }
    return resolveQueueSkipReason(handle);
  }

  /**
   * 执行单个步骤（可被 executeWorkflow 调度，也可单独调用）。
   * 公开 API 不暴露内部 StepRuntime；workflow 步骤需在 executeWorkflow 上下文中运行。
   */
  async function executeStep(
    workflowRunId: string,
    step: WorkflowStep,
    context: ExecutionContext,
    meta?: WorkflowRunMeta,
    signal?: AbortSignal,
    handle?: RunHandle,
  ): Promise<ExecutionResult> {
    return executeStepInternal(workflowRunId, step, context, meta, signal, handle, {
      nestingDepth: 0,
      ancestorWorkflowIds: [],
    });
  }

  async function executeStepInternal(
    workflowRunId: string,
    step: WorkflowStep,
    context: ExecutionContext,
    meta: WorkflowRunMeta | undefined,
    signal: AbortSignal | undefined,
    handle: RunHandle | undefined,
    runtime: StepRuntime,
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
      await onStepStart?.(step, context, meta, {
        emitQueued: async (info) => {
          if (!meta) return;
          await emit(
            buildEvent(workflowRunId, {
              type: WorkflowEventTypes.STEP_QUEUED,
              meta,
              step,
              resourceType: info.resourceType,
              priority: info.priority,
            }),
          );
        },
      });
      if (meta) {
        await emit(
          buildEvent(workflowRunId, {
            type: WorkflowEventTypes.STEP_START,
            meta,
            step,
          }),
        );
      }

      const kind = getStepKind(step);

      if (kind === StepKinds.SET_STATE) {
        return await executeSetStateStep(workflowRunId, step, context, meta, runtime);
      }

      if (kind === StepKinds.WORKFLOW) {
        return await executeWorkflowRefStep(
          workflowRunId,
          step,
          context,
          meta,
          signal,
          handle,
          runtime,
        );
      }

      return await executePluginStep(workflowRunId, step, context, meta, signal, handle, runtime);
    } catch (error) {
      if (error instanceof PluginCancelledError) {
        const executionResult = buildSkippedResult(step.id, resolveInFlightAbortSkipReason(handle));
        await notifyStepComplete(workflowRunId, step, executionResult, context, meta);
        return executionResult;
      }

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

  async function executeSetStateStep(
    workflowRunId: string,
    step: WorkflowStep,
    context: ExecutionContext,
    meta: WorkflowRunMeta | undefined,
    runtime: StepRuntime,
  ): Promise<ExecutionResult> {
    if (!isSetStateStep(step)) {
      return finalizeFailure(
        workflowRunId,
        step,
        buildFailedResult(step.id, {
          error: new Error(`步骤 ${step.id} 缺少 patch`),
          failureKind: StepFailureKinds.INTERNAL,
        }),
        context,
        meta,
      );
    }

    const runState = runtime.runState;
    if (!runState) {
      return finalizeFailure(
        workflowRunId,
        step,
        buildFailedResult(step.id, {
          error: new Error(
            `步骤 ${step.id} 为 set_state，但当前 run 无 state（未声明 stateSchema）`,
          ),
          failureKind: StepFailureKinds.INTERNAL,
        }),
        context,
        meta,
      );
    }

    const resolvedPatch = resolveConfigReferences(
      step.patch,
      context.previousResultsData ?? {},
      step.id,
      { runState: runState.current },
    );

    if (
      typeof resolvedPatch !== 'object' ||
      resolvedPatch === null ||
      Array.isArray(resolvedPatch)
    ) {
      return finalizeFailure(
        workflowRunId,
        step,
        buildFailedResult(step.id, {
          error: new Error(`步骤 ${step.id} 的 patch 解析后必须是对象`),
          failureKind: StepFailureKinds.CONFIG_RESOLUTION,
        }),
        context,
        meta,
      );
    }

    const merged = { ...asRecord(runState.current), ...(resolvedPatch as Record<string, unknown>) };
    const parsed = parseState(runState.schema, merged);
    if (!parsed.success) {
      return finalizeFailure(
        workflowRunId,
        step,
        buildFailedResult(step.id, {
          error: new Error(`步骤 ${step.id} set_state 后 state 校验失败：${parsed.message}`),
          failureKind: StepFailureKinds.INTERNAL,
        }),
        context,
        meta,
      );
    }

    runState.current = parsed.data;
    const pluginResult: PluginResult = { success: true, data: parsed.data };
    const executionResult = buildCompletedResult(step.id, pluginResult);
    await notifyStepComplete(workflowRunId, step, executionResult, context, meta);
    return executionResult;
  }

  async function executeWorkflowRefStep(
    workflowRunId: string,
    step: WorkflowStep,
    context: ExecutionContext,
    meta: WorkflowRunMeta | undefined,
    signal: AbortSignal | undefined,
    handle: RunHandle | undefined,
    runtime: StepRuntime,
  ): Promise<ExecutionResult> {
    if (!isWorkflowRefStep(step)) {
      return finalizeFailure(
        workflowRunId,
        step,
        buildFailedResult(step.id, {
          error: new Error(`步骤 ${step.id} 缺少 workflowRef`),
          failureKind: StepFailureKinds.INTERNAL,
        }),
        context,
        meta,
      );
    }

    const resolveWorkflow = runtime.resolveWorkflow;
    if (!resolveWorkflow) {
      return finalizeFailure(
        workflowRunId,
        step,
        buildFailedResult(step.id, {
          error: new Error(`步骤 ${step.id} 为 workflow 引用，但未提供 resolveWorkflow`),
          failureKind: StepFailureKinds.INTERNAL,
        }),
        context,
        meta,
      );
    }

    if (signal?.aborted) {
      const executionResult = buildSkippedResult(step.id, resolveInFlightAbortSkipReason(handle));
      await notifyStepComplete(workflowRunId, step, executionResult, context, meta);
      return executionResult;
    }

    const nextDepth = runtime.nestingDepth + 1;
    if (nextDepth > maxNestingDepth) {
      return finalizeFailure(
        workflowRunId,
        step,
        buildFailedResult(step.id, {
          error: new Error(`步骤 ${step.id} 嵌套深度 ${nextDepth} 超过上限 ${maxNestingDepth}`),
          failureKind: StepFailureKinds.INTERNAL,
        }),
        context,
        meta,
      );
    }

    const maxIterations = step.loop?.maxIterations ?? 1;
    const iterations: Array<{ index: number; state?: unknown; success: boolean }> = [];
    let lastSuccess = true;
    let lastState: unknown;
    let stateIn = resolveInputState(step, context, runtime);

    let activeChildRunId: string | undefined;
    const unsubscribers: Array<() => void> = [];
    if (handle) {
      unsubscribers.push(
        handle.onPauseRequested(async (options) => {
          if (!activeChildRunId) return;
          await pauseRun(activeChildRunId, options);
          handle.markNestedPaused(step.id);
        }),
        handle.onResumeRequested(async () => {
          if (!activeChildRunId) return;
          handle.clearNestedPaused(step.id);
          await resumeRun(activeChildRunId);
        }),
        handle.onCancelRequested(async (options) => {
          if (!activeChildRunId) return;
          await cancelRun(activeChildRunId, options);
        }),
      );
    }

    try {
      for (let i = 0; i < maxIterations; i++) {
        if (signal?.aborted || handle?.shouldStopScheduling()) {
          const skipReason = signal?.aborted
            ? resolveInFlightAbortSkipReason(handle)
            : resolveAbortSkipReason(handle?.getAbortReason() ?? 'user_cancel');
          const executionResult = buildSkippedResult(step.id, skipReason);
          await notifyStepComplete(workflowRunId, step, executionResult, context, meta);
          return executionResult;
        }

        const childDefinition = await resolveWorkflow(step.workflowRef.importId);
        if (runtime.ancestorWorkflowIds.includes(childDefinition.id)) {
          return finalizeFailure(
            workflowRunId,
            step,
            buildFailedResult(step.id, {
              error: new Error(`步骤 ${step.id} 引用工作流 "${childDefinition.id}" 形成引用环`),
              failureKind: StepFailureKinds.INTERNAL,
            }),
            context,
            meta,
          );
        }

        // 禁止循环嵌套循环：本步带 loop 时，子定义不得再含带 loop 的 workflow 步骤
        if (step.loop !== undefined) {
          const nestedLoop = childDefinition.steps.find(
            (s) => isWorkflowRefStep(s) && s.loop !== undefined,
          );
          if (nestedLoop) {
            return finalizeFailure(
              workflowRunId,
              step,
              buildFailedResult(step.id, {
                error: new Error(
                  `禁止循环嵌套循环：步骤 ${step.id} 带 loop，但子工作流 "${childDefinition.id}" 含带 loop 的步骤 "${nestedLoop.id}"`,
                ),
                failureKind: StepFailureKinds.INTERNAL,
              }),
              context,
              meta,
            );
          }
        }

        if (step.loop?.until && childDefinition.stateSchema === undefined) {
          return finalizeFailure(
            workflowRunId,
            step,
            buildFailedResult(step.id, {
              error: new Error(
                `步骤 ${step.id} 配置了 loop.until，但被引用工作流未声明 stateSchema`,
              ),
              failureKind: StepFailureKinds.INTERNAL,
            }),
            context,
            meta,
          );
        }

        if (stateIn !== undefined && childDefinition.stateSchema === undefined) {
          return finalizeFailure(
            workflowRunId,
            step,
            buildFailedResult(step.id, {
              error: new Error(
                `步骤 ${step.id} 传入了 inputState，但被引用工作流未声明 stateSchema`,
              ),
              failureKind: StepFailureKinds.INTERNAL,
            }),
            context,
            meta,
          );
        }

        const childRunId = deriveChildRunId(workflowRunId, step.id, i);
        activeChildRunId = childRunId;
        const parentCtx: WorkflowEventParent = {
          runId: workflowRunId,
          stepId: step.id,
          iteration: i,
        };
        eventParents.set(childRunId, parentCtx);

        if (meta) {
          await emit(
            buildEvent(workflowRunId, {
              type: WorkflowEventTypes.WORKFLOW_ITERATION_START,
              meta,
              step,
              iteration: i,
            }),
          );
        }

        const hooks = runtime.embeddedRunHooks;
        await hooks?.onChildRunStart(childRunId, childDefinition, {
          parentRunId: workflowRunId,
          stepId: step.id,
          iteration: i,
        });

        let childResult: WorkflowRunResult;
        try {
          childResult = await executeWorkflow(
            childRunId,
            childDefinition,
            {
              ...stripCallerRunId(context),
              artifacts: context.artifacts,
            },
            {
              initialState: stateIn,
              resolveWorkflow,
              embeddedRunHooks: hooks,
              nestingDepth: nextDepth,
              ancestorWorkflowIds: [...runtime.ancestorWorkflowIds, childDefinition.id],
            },
          );
        } finally {
          eventParents.delete(childRunId);
        }

        activeChildRunId = undefined;
        handle?.clearNestedPaused(step.id);
        await hooks?.onChildRunFinished(childRunId, childResult);

        if (meta) {
          await emit(
            buildEvent(workflowRunId, {
              type: WorkflowEventTypes.WORKFLOW_ITERATION_FINISHED,
              meta,
              step,
              iteration: i,
              childResult: {
                childRunId,
                success: childResult.success,
                status: childResult.status,
                ...(childResult.state !== undefined ? { state: childResult.state } : {}),
              },
            }),
          );
        }

        iterations.push({
          index: i,
          state: childResult.state,
          success: childResult.success,
        });
        lastSuccess = childResult.success;
        lastState = childResult.state;

        if (handle?.getAbortReason() === 'user_cancel' || handle?.getAbortReason() === 'destroy') {
          const executionResult = buildSkippedResult(
            step.id,
            resolveAbortSkipReason(handle.getAbortReason()),
          );
          await notifyStepComplete(workflowRunId, step, executionResult, context, meta);
          return executionResult;
        }

        if (!childResult.success) {
          break;
        }

        if (step.loop?.until && checkCondition(step.loop.until, asRecord(childResult.state))) {
          break;
        }

        stateIn = childResult.state;
      }
    } finally {
      activeChildRunId = undefined;
      for (const unsub of unsubscribers) unsub();
      handle?.clearNestedPaused(step.id);
    }

    const data = {
      state: lastState,
      iterations,
      iterationCount: iterations.length,
    };

    if (!lastSuccess) {
      const pluginResult: PluginResult = {
        success: false,
        message: `子工作流执行失败（共 ${iterations.length} 轮）`,
        data,
      };
      return finalizeFailure(
        workflowRunId,
        step,
        buildFailedResult(step.id, {
          pluginResult,
          error: new Error(pluginResult.message!),
          failureKind: StepFailureKinds.SUBWORKFLOW_FAILED,
        }),
        context,
        meta,
      );
    }

    const pluginResult: PluginResult = { success: true, data };
    const executionResult = buildCompletedResult(step.id, pluginResult);
    await notifyStepComplete(workflowRunId, step, executionResult, context, meta);
    return executionResult;
  }

  function resolveInputState(
    step: WorkflowRefStep,
    context: ExecutionContext,
    runtime: StepRuntime,
  ): unknown {
    if (step.inputState === undefined) return undefined;
    return resolveConfigReferences(step.inputState, context.previousResultsData ?? {}, step.id, {
      runState: runtime.runState?.current,
    });
  }

  async function executePluginStep(
    workflowRunId: string,
    step: WorkflowStep,
    context: ExecutionContext,
    meta: WorkflowRunMeta | undefined,
    signal: AbortSignal | undefined,
    handle: RunHandle | undefined,
    runtime: StepRuntime,
  ): Promise<ExecutionResult> {
    if (!isPluginStep(step)) {
      return finalizeFailure(
        workflowRunId,
        step,
        buildFailedResult(step.id, {
          error: new Error(`步骤 ${step.id} 缺少 plugin/config`),
          failureKind: StepFailureKinds.INTERNAL,
        }),
        context,
        meta,
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
        const executionResult = buildSkippedResult(step.id, resolveInFlightAbortSkipReason(handle));
        await notifyStepComplete(workflowRunId, step, executionResult, context, meta);
        return executionResult;
      }

      const resolvedConfig = resolveConfigReferences(
        step.config,
        context.previousResultsData ?? {},
        step.id,
        { runState: runtime.runState?.current },
      ) as typeof step.config;

      const raced = await racePluginWithInFlightAbort(
        () => pluginExecutor(step.plugin, resolvedConfig, pluginContext),
        signal,
        () => handle?.isInFlightAbortActive() ?? false,
        inFlightTimeoutMs,
      );

      if (raced.outcome === 'timeout') {
        const executionResult = buildSkippedResult(step.id, resolveInFlightAbortSkipReason(handle));
        await notifyStepComplete(workflowRunId, step, executionResult, context, meta, {
          deferReleaseUntil: raced.pluginSettled,
        });
        return executionResult;
      }

      pluginResult = raced.result;
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

    if (!pluginResult.success && pluginResult.code === PluginFailureCodes.PLUGIN_CANCELLED) {
      const executionResult = buildSkippedResult(step.id, resolveInFlightAbortSkipReason(handle));
      await notifyStepComplete(workflowRunId, step, executionResult, context, meta);
      return executionResult;
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
  }

  /** 为补发 step:finished 等场景构造最小 ExecutionContext */
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

  /**
   * 某步骤完成后，更新下游入度并将新就绪步骤加入 ready 队列。
   * 若依赖链上有 FAILED，直接标记 DEPENDENCY_FAILED 并递归传播（不再执行插件）。
   */
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

  /**
   * waitInFlight 模式下，最后一个 in-flight 结束时将 pausing → paused 并发出 workflow:paused。
   * 避免在仍有步骤执行中时提前发 paused 事件。
   */
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
   * 执行完整工作流（DAG 调度主循环）。
   *
   * 1. 校验 workflowRunId + DAG + step kinds，注册 RunHandle，发出 workflow:start
   * 2. ready 队列 + inFlight 池并行执行，上限 maxParallelSteps
   * 3. 每步完成后 propagateDependents 解锁下游
   * 4. 循环内处理：failFast 中止、用户取消、暂停/恢复
   * 5. 收尾：补发未执行步骤的 step:finished，汇总 WorkflowRunResult（含 state），workflow:finished
   */
  async function executeWorkflow(
    workflowRunId: string,
    workflow: WorkflowDefinition,
    context: Partial<ExecutionContext> = {},
    callOptions: ExecuteWorkflowCallOptions = {},
  ): Promise<WorkflowRunResult> {
    assertValidWorkflowRunId(workflowRunId);
    const handle = registry.register(workflowRunId);
    handle.setTotalSteps(workflow.steps.length);

    const resolveWorkflow = callOptions.resolveWorkflow ?? defaultResolveWorkflow;
    const embeddedRunHooks = callOptions.embeddedRunHooks ?? defaultEmbeddedRunHooks;
    const nestingDepth = callOptions.nestingDepth ?? 0;
    const ancestorWorkflowIds =
      callOptions.ancestorWorkflowIds ?? (workflow.id ? [workflow.id] : []);

    try {
      const graph = validateDag(workflow.steps);
      validateStepKinds(workflow);
      validateWorkflowContextReferences(workflow, { resolvePluginResultSchema });

      if (callOptions.initialState !== undefined && workflow.stateSchema === undefined) {
        throw new WorkflowValidationError(
          `工作流 "${workflow.id}" 未声明 stateSchema，不允许传入 initialState`,
        );
      }

      let runState: RunStateBag | undefined;
      if (workflow.stateSchema !== undefined) {
        const initial =
          callOptions.initialState !== undefined
            ? callOptions.initialState
            : defaultStateFromSchema(workflow.stateSchema);
        const parsed = parseState(workflow.stateSchema, initial);
        if (!parsed.success) {
          throw new WorkflowValidationError(`initialState 不符合 stateSchema：${parsed.message}`);
        }
        runState = { current: parsed.data, schema: workflow.stateSchema };
      }

      const cleanContext = stripCallerRunId(context);
      const runMeta = buildRunMeta(workflow.id, cleanContext);
      handle.setRunMeta(runMeta);
      const traceId = runMeta.traceId;
      const runContext: Partial<ExecutionContext> = {
        ...cleanContext,
        runId: workflowRunId,
        ...(traceId !== undefined ? { traceId } : {}),
        ...(runState ? { [WorkflowContextKeys.state]: runState.current } : {}),
      };

      const stepRuntime: StepRuntime = {
        runState,
        resolveWorkflow,
        embeddedRunHooks,
        nestingDepth,
        ancestorWorkflowIds,
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

      /** 单步包装：track in-flight、执行、传播依赖、更新进度 */
      const runStep = async (stepId: string) => {
        const step = graph.stepById.get(stepId)!;
        const signal = handle.trackInFlight(stepId);
        try {
          const executionContext: ExecutionContext = {
            ...runContext,
            workflowId: workflow.id,
            stepId: step.id,
            previousResults: toPreviousResults(results),
            previousResultsData: toPreviousResultsData(results),
            ...(runState ? { [WorkflowContextKeys.state]: runState.current } : {}),
          };

          const result = await executeStepInternal(
            workflowRunId,
            step,
            executionContext,
            runMeta,
            signal,
            handle,
            stepRuntime,
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

      // 主调度循环：有就绪步骤、in-flight 步骤或处于暂停态时持续运转
      while (ready.length > 0 || inFlight.size > 0 || handle.isPaused() || handle.isPausing()) {
        if (workflowFailed && failFast) {
          handle.setFailFastAbort();
        }

        const stopScheduling = handle.shouldStopScheduling() || (workflowFailed && failFast);

        // 首次进入中止态：清空 ready、通知引擎取消资源排队
        if (stopScheduling && !workflowAborted) {
          workflowAborted = true;
          onWorkflowAbort?.(workflowRunId);
          ready.length = 0;
        }

        // 暂停：阻塞调度直至 resume；pausing 等 in-flight 清空后转 paused
        if (handle.isPaused() || handle.isPausing()) {
          if (handle.isPaused()) {
            await handle.waitUntilResumed();
          }
          if (inFlight.size === 0 && handle.isPausing()) {
            await maybeEmitPaused(workflowRunId, handle, runMeta);
          }
          if (inFlight.size === 0) continue;
        }

        // 从 ready 取出步骤填满 inFlight 池（受 maxParallelSteps 与 stopScheduling 约束）
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

        // 等待任意 in-flight 步骤完成以释放槽位（或退出暂停等待）
        if (inFlight.size === 0) {
          if (handle.isPaused() || handle.isPausing()) continue;
          break;
        }

        await Promise.race(inFlight.values());
      }

      // 用户取消 / destroy：为尚未执行的步骤补发 step:finished（USER_CANCELLED 等）
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
        // failFast:false 时，因依赖失败未能调度的步骤标记 DEPENDENCY_FAILED
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

      executionHistory.set(workflowRunId, finalResults);

      let finalState: unknown | undefined;
      if (runState) {
        const parsed = parseState(runState.schema, runState.current);
        if (!parsed.success) {
          throw new WorkflowValidationError(
            `工作流结束时 state 不符合 stateSchema：${parsed.message}`,
          );
        }
        finalState = parsed.data;
      }

      const runResult = buildWorkflowRunResult(workflow.id, finalResults, handle, finalState);
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
      // Run 结束即从活跃表移除；终态写入 RunRegistry 缓存供 getRunStatus 查询
      registry.unregister(workflowRunId);
    }
  }

  /** 请求取消 Run；首次进入 cancelling 时发 workflow:cancelled 并触发 onWorkflowAbort */
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

  /**
   * 请求暂停 Run。waitInFlight 时先进入 pausing，待 in-flight 清空后由 maybeEmitPaused 发 workflow:paused。
   * abortInFlight 会向 in-flight 注入 AbortSignal（与 hard cancel 共用超时语义）。
   */
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

    const shouldWaitForPaused =
      result.currentStatus === 'pausing' &&
      ((options.waitInFlight ?? true) || (options.abortInFlight ?? false));

    if (shouldWaitForPaused) {
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

  /** 从 paused 恢复为 running，发出 workflow:resumed */
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

  /** 查询活跃或终态缓存的 Run 快照（含 inFlightSteps、进度） */
  function getRunStatus(workflowRunId: string): RunStatusSnapshot | undefined {
    return registry.getStatus(workflowRunId);
  }

  /** destroy 前取消所有活跃 Run：先 onWorkflowAbort 清资源队列，再 hard abort in-flight */
  async function destroyActiveRuns(): Promise<void> {
    for (const handle of registry.getAllActive()) {
      onWorkflowAbort?.(handle.workflowRunId);
    }
    await registry.destroyAll();
  }

  /** 按 workflowRunId 读取最近一次 executeWorkflow 的步骤结果 */
  function getExecutionHistory(workflowRunId: string): ExecutionResult[] | undefined {
    return executionHistory.get(workflowRunId);
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
