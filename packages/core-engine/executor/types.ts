/**
 * 执行器类型定义
 * @module executor/types
 */

import type { PluginConfig, PluginContext, PluginResult } from "@monai-devops/plugin-sdk";
import type {
  SkipReason,
  StepFailureKind,
  StepStatus,
} from "../errors.js";
import type { WorkflowObserver } from "../observer/index.js";

/**
 * 工作流定义
 */
export interface WorkflowDefinition {
  id: string;
  name: string;
  steps: WorkflowStep[];
}

/**
 * 结构化步骤条件
 */
export interface StepCondition {
  when: string;
  equals?: unknown;
  exists?: boolean;
}

/**
 * 工作流步骤
 */
export interface WorkflowStep {
  id: string;
  name: string;
  plugin: string;
  config: PluginConfig;
  condition?: StepCondition;
  dependsOn?: string[];
}

/**
 * 执行上下文
 */
export interface ExecutionContext extends PluginContext {
  workflowId: string;
  stepId: string;
  previousResults?: Record<string, unknown>;
  artifacts?: Record<string, unknown>;
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

/**
 * 工作流运行结果
 */
export interface WorkflowRunResult {
  success: boolean;
  workflowId: string;
  results: ExecutionResult[];
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
  /** 生命周期观察者，供调用层接收执行期事件 */
  observer?: WorkflowObserver;
  /** 引擎内部/高级定制：步骤开始钩子 */
  onStepStart?: (step: WorkflowStep) => void;
  /** 引擎内部/高级定制：步骤完成钩子（含失败与跳过） */
  onStepComplete?: (step: WorkflowStep, result: ExecutionResult) => void;
  /** 引擎内部/高级定制：步骤错误钩子（失败时在 onStepComplete 之前调用） */
  onStepError?: (step: WorkflowStep, error: Error) => void;
}
