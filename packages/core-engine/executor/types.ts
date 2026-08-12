/**
 * 执行器类型定义
 * @module executor/types
 */

import type { PluginConfig, PluginContext, PluginResult, ZodType } from '@monai-devops/plugin-sdk';
import type { SkipReason, StepFailureKind, StepStatus } from '../errors.js';
import type { WorkflowObserver, WorkflowRunMeta } from '../observer/index.js';

/**
 * JSON Schema 对象（前端表单构建器 / 手填产出，持久化与传输形态）。
 * 运行时由 state-schema 工具转为 ZodType。
 */
export type JsonSchemaObject = Record<string, unknown>;

/**
 * 工作流定义
 */
export interface WorkflowDefinition {
  id: string;
  name: string;
  steps: WorkflowStep[];
  /**
   * 可选：声明 state 的结构。按需提供——纯副作用工作流可不声明。
   * 持久化为 JSON Schema（不是 Zod 代码）。
   */
  stateSchema?: JsonSchemaObject;
}

/**
 * 结构化步骤条件（针对 previousResults）
 */
export interface StepCondition {
  when: string;
  equals?: unknown;
  exists?: boolean;
}

/**
 * 基于 state 的条件（结构同 StepCondition，求值对象为 state）
 */
export type StateCondition = StepCondition;

export const StepKinds = {
  PLUGIN: 'plugin',
  WORKFLOW: 'workflow',
  SET_STATE: 'set_state',
} as const;

export type StepKind = (typeof StepKinds)[keyof typeof StepKinds];

interface BaseStep {
  id: string;
  name: string;
  condition?: StepCondition;
  dependsOn?: string[];
  /** 资源调度优先级，数值越小越优先；默认继承 run 级 priority */
  priority?: number;
}

/** 未带 kind 字段的历史数据按 PLUGIN 处理 */
export interface PluginStep extends BaseStep {
  kind?: typeof StepKinds.PLUGIN;
  plugin: string;
  config: PluginConfig;
}

export interface SetStateStep extends BaseStep {
  kind: typeof StepKinds.SET_STATE;
  /** 值可以是字面量，也可以是 ContextRef */
  patch: Record<string, unknown>;
}

export interface WorkflowRefStep extends BaseStep {
  kind: typeof StepKinds.WORKFLOW;
  /**
   * 显式「导入」产生的引用；只存 importId。
   * workflowId/mode 以 WorkflowImport 为唯一数据源。
   */
  workflowRef: {
    importId: string;
  };
  /** 首轮传入子工作流的初始 state；仅当被引用工作流声明了 stateSchema 时有意义 */
  inputState?: unknown;
  /**
   * 可选：不配置则单次执行；配置则循环。
   * 是否循环是引用步骤的属性，不是被引用工作流定义的属性。
   */
  loop?: {
    maxIterations: number;
    /** 基于上一轮 state_out；仅当被引用工作流声明了 stateSchema 时可配置 */
    until?: StateCondition;
  };
}

export type WorkflowStep = PluginStep | SetStateStep | WorkflowRefStep;

export function getStepKind(step: WorkflowStep): StepKind {
  return step.kind ?? StepKinds.PLUGIN;
}

export function isPluginStep(step: WorkflowStep): step is PluginStep {
  return getStepKind(step) === StepKinds.PLUGIN;
}

export function isSetStateStep(step: WorkflowStep): step is SetStateStep {
  return getStepKind(step) === StepKinds.SET_STATE;
}

export function isWorkflowRefStep(step: WorkflowStep): step is WorkflowRefStep {
  return getStepKind(step) === StepKinds.WORKFLOW;
}

/**
 * 执行上下文
 */
export interface ExecutionContext extends PluginContext {
  workflowId: string;
  stepId: string;
  previousResults?: Record<string, unknown>;
  /** 仅 COMPLETED 且 pluginResult.success 的 data（供 config $ref 解析） */
  previousResultsData?: Record<string, unknown>;
  artifacts?: Record<string, unknown>;
  /** run 级默认调度优先级，步骤 priority 可覆盖 */
  priority?: number;
}

/**
 * 执行结果
 */
export interface ExecutionResult {
  stepId: string;
  status: StepStatus;
  success: boolean;
  result?: unknown;
  pluginResult?: PluginResult;
  error?: Error;
  failureKind?: StepFailureKind;
  skipReason?: SkipReason;
}

export type WorkflowRunStatus = 'success' | 'failed' | 'cancelled';

export type RunControlStatus =
  | 'running'
  | 'pausing'
  | 'paused'
  | 'cancelling'
  | 'cancelled'
  | 'finished'
  | 'failed'
  | 'unknown';

export type AbortSchedulingReason = 'none' | 'fail_fast' | 'user_cancel' | 'destroy';

export type RunControlMode = 'best-effort' | 'hard';

export interface CancelRunOptions {
  mode?: RunControlMode;
}

export interface PauseRunOptions {
  waitInFlight?: boolean;
  abortInFlight?: boolean;
}

export interface RunControlResult {
  workflowRunId: string;
  action: 'cancel' | 'pause' | 'resume';
  previousStatus: RunControlStatus;
  currentStatus: RunControlStatus;
  mode?: RunControlMode;
  inFlightSteps?: string[];
}

export interface RunStatusSnapshot {
  workflowRunId: string;
  status: RunControlStatus;
  inFlightSteps: string[];
  progress?: { completed: number; total: number };
}

/**
 * 工作流运行结果
 */
export interface WorkflowRunResult {
  success: boolean;
  status: WorkflowRunStatus;
  workflowId: string;
  results: ExecutionResult[];
  /** 仅当 workflow.stateSchema 已声明时出现 */
  state?: unknown;
}

/**
 * 按 importId 解析子工作流定义（经 WorkflowImport → Workflow 两跳）。
 * reference / copy 运行时统一走此入口。
 */
export type ResolveWorkflow = (importId: string) => Promise<WorkflowDefinition>;

/**
 * 子 run 落表回调（区别于扁平 observer，承载建行/收尾边界操作）
 */
export interface EmbeddedRunHooks {
  onChildRunStart(
    childRunId: string,
    childDefinition: WorkflowDefinition,
    ctx: { parentRunId: string; stepId: string; iteration: number },
  ): Promise<void>;
  onChildRunFinished(childRunId: string, result: WorkflowRunResult): Promise<void>;
}

/**
 * 单次 executeWorkflow 调用可选覆盖项（优先于 ExecutorOptions 默认值）
 */
export interface ExecuteWorkflowCallOptions {
  initialState?: unknown;
  resolveWorkflow?: ResolveWorkflow;
  embeddedRunHooks?: EmbeddedRunHooks;
  /** 当前嵌套深度（内部传递；顶层为 0） */
  nestingDepth?: number;
  /** 祖先工作流 id 链（含当前），用于引用环检测 */
  ancestorWorkflowIds?: string[];
}

/**
 * onStepComplete 可选控制项（引擎用于推迟资源释放等）
 */
export interface StepCompleteOptions {
  /** 推迟资源释放，直至该 Promise settle（用于 in-flight abort 超时后插件仍在运行） */
  deferReleaseUntil?: Promise<unknown>;
}

/**
 * 插件执行器类型
 */
export type PluginExecutor = (
  pluginName: string,
  config: PluginConfig,
  context: PluginContext,
) => Promise<PluginResult>;

/**
 * 执行器选项
 */
export interface ExecutorOptions {
  pluginExecutor?: PluginExecutor;
  maxParallelSteps?: number;
  failFast?: boolean;
  /** hard cancel 时 in-flight 步骤超时（ms），默认 30000 */
  inFlightTimeoutMs?: number;
  /** 生命周期观察者，供调用层接收执行期事件 */
  observer?: WorkflowObserver;
  /** 引擎内部/高级定制：步骤开始钩子（在 step:start 之前 await，可用于资源挂起） */
  onStepStart?: (
    step: WorkflowStep,
    context: ExecutionContext,
    meta?: WorkflowRunMeta,
    helpers?: {
      /** 资源入队时通过 executor.emit 发出 step:queued（自动带 parent） */
      emitQueued: (info: { resourceType: string; priority: number }) => void | Promise<void>;
    },
  ) => void | Promise<void>;
  /** 引擎内部/高级定制：步骤完成钩子（含失败与跳过） */
  onStepComplete?: (
    step: WorkflowStep,
    result: ExecutionResult,
    context: ExecutionContext,
    options?: StepCompleteOptions,
  ) => void;
  /** 引擎内部/高级定制：步骤错误钩子（失败时在 onStepComplete 之前调用） */
  onStepError?: (step: WorkflowStep, error: Error, context: ExecutionContext) => void;
  /** failFast 中止时取消同 workflowRunId 下排队中的资源等待 */
  onWorkflowAbort?: (workflowRunId: string) => void;
  /** 查询插件 resultSchema；用于启动前校验 ContextRef 来源是否允许被引用 */
  resolvePluginResultSchema?: (pluginName: string) => ZodType | undefined;
  /** 按 importId 解析子工作流（可被单次调用 options 覆盖） */
  resolveWorkflow?: ResolveWorkflow;
  /** 子 run 落表钩子（可被单次调用 options 覆盖） */
  embeddedRunHooks?: EmbeddedRunHooks;
  /** 嵌套深度上限，默认 3 */
  maxNestingDepth?: number;
}
