/**
 * 上游步骤结果引用：识别、解析与静态校验
 * @module executor/context-reference
 */

import type { ZodType } from '@monai-devops/plugin-sdk';
import { StepExecutionError, StepFailureKinds, WorkflowValidationError } from '../errors.js';
import { SET_STATE_RESULT_SCHEMA, WORKFLOW_REF_RESULT_SCHEMA } from './builtin-step-kinds.js';
import { getStepReferencePayload } from './step-kind-validation.js';
import {
  getStepKind,
  isPluginStep,
  StepKinds,
  type WorkflowDefinition,
  type WorkflowStep,
} from './types.js';

/** `$ref.fromStepId` 保留值：指向本工作流当前 run state（非真实步骤 id） */
export const WORKFLOW_STATE_REF_ID = '__workflow_state__';

export type ContextRef = {
  $ref: {
    fromStepId: string;
    path: string[];
  };
};

export function isContextRef(value: unknown): value is ContextRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  if (!('$ref' in value)) return false;
  const ref = (value as { $ref: unknown }).$ref;
  if (typeof ref !== 'object' || ref === null || Array.isArray(ref)) {
    return false;
  }
  const { fromStepId, path } = ref as { fromStepId?: unknown; path?: unknown };
  return (
    typeof fromStepId === 'string' &&
    Array.isArray(path) &&
    path.every((segment) => typeof segment === 'string')
  );
}

export function isWorkflowStateRef(value: ContextRef): boolean {
  return value.$ref.fromStepId === WORKFLOW_STATE_REF_ID;
}

/** 递归收集 config 中全部 ContextRef（深度优先） */
export function extractContextReferences(config: unknown): ContextRef[] {
  const refs: ContextRef[] = [];

  function walk(value: unknown): void {
    if (isContextRef(value)) {
      refs.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const child of Object.values(value)) walk(child);
    }
  }

  walk(config);
  return refs;
}

/**
 * 按 path 逐段下钻取值。
 * - 数组：段解析为整数下标
 * - 普通对象：段作为 key
 * - key/下标不存在 → 抛 CONFIG_RESOLUTION
 * - 取到 null 视为合法
 */
export function getValueByPath(
  root: unknown,
  path: string[],
  stepId: string,
  fromStepId: string,
): unknown {
  let current: unknown = root;

  for (let i = 0; i < path.length; i++) {
    const segment = path[i]!;
    const pathSoFar = path.slice(0, i + 1).join('.');

    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) {
        throw new StepExecutionError(
          `步骤 "${stepId}" 的 config 引用路径 "${pathSoFar}" 在步骤 "${fromStepId}" 的结果中不存在`,
          StepFailureKinds.CONFIG_RESOLUTION,
        );
      }
      const index = Number(segment);
      if (index < 0 || index >= current.length || !(index in current)) {
        throw new StepExecutionError(
          `步骤 "${stepId}" 的 config 引用路径 "${pathSoFar}" 在步骤 "${fromStepId}" 的结果中不存在`,
          StepFailureKinds.CONFIG_RESOLUTION,
        );
      }
      current = current[index];
      continue;
    }

    if (typeof current === 'object' && current !== null) {
      const record = current as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(record, segment)) {
        throw new StepExecutionError(
          `步骤 "${stepId}" 的 config 引用路径 "${pathSoFar}" 在步骤 "${fromStepId}" 的结果中不存在`,
          StepFailureKinds.CONFIG_RESOLUTION,
        );
      }
      current = record[segment];
      continue;
    }

    throw new StepExecutionError(
      `步骤 "${stepId}" 的 config 引用路径 "${pathSoFar}" 在步骤 "${fromStepId}" 的结果中不存在`,
      StepFailureKinds.CONFIG_RESOLUTION,
    );
  }

  return current;
}

export interface ResolveConfigReferencesOptions {
  /** 当前 run state；用于解析 WORKFLOW_STATE_REF_ID */
  runState?: unknown;
}

/**
 * 递归解析 config 中的 ContextRef，整字段替换为上游 data / 工作流 state 中的值。
 * 失败时抛出 StepExecutionError(CONFIG_RESOLUTION)。
 */
export function resolveConfigReferences(
  config: unknown,
  previousResultsData: Record<string, unknown>,
  stepId = '',
  options: ResolveConfigReferencesOptions = {},
): unknown {
  if (isContextRef(config)) {
    const { fromStepId, path } = config.$ref;
    if (fromStepId === WORKFLOW_STATE_REF_ID) {
      if (options.runState === undefined) {
        throw new StepExecutionError(
          `步骤 "${stepId}" 的 config 引用了工作流 state，但当前 run 无 state`,
          StepFailureKinds.CONFIG_RESOLUTION,
        );
      }
      return getValueByPath(options.runState, path, stepId, 'state');
    }
    if (!(fromStepId in previousResultsData)) {
      throw new StepExecutionError(
        `步骤 "${stepId}" 的 config 引用了步骤 "${fromStepId}"，但该步骤没有可用的执行结果`,
        StepFailureKinds.CONFIG_RESOLUTION,
      );
    }
    return getValueByPath(previousResultsData[fromStepId], path, stepId, fromStepId);
  }

  if (Array.isArray(config)) {
    return config.map((item) =>
      resolveConfigReferences(item, previousResultsData, stepId, options),
    );
  }

  if (typeof config === 'object' && config !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
      out[key] = resolveConfigReferences(value, previousResultsData, stepId, options);
    }
    return out;
  }

  return config;
}

/** 沿 dependsOn 反向收集祖先 stepId（不含自身） */
export function getAncestorIds(
  stepId: string,
  steps: Array<{ id: string; dependsOn?: string[] }>,
): Set<string> {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const ancestors = new Set<string>();
  const stack = [...(byId.get(stepId)?.dependsOn ?? [])];

  while (stack.length > 0) {
    const id = stack.pop()!;
    if (ancestors.has(id)) continue;
    ancestors.add(id);
    const step = byId.get(id);
    if (step?.dependsOn) {
      for (const dep of step.dependsOn) stack.push(dep);
    }
  }

  return ancestors;
}

export interface ValidateWorkflowContextReferencesOptions {
  /** 返回插件的 resultSchema；未声明时返回 undefined */
  resolvePluginResultSchema?: (pluginName: string) => ZodType | undefined;
}

/** 按来源步骤 kind 解析可用于 $ref 校验的 resultSchema */
export function resolveStepResultSchema(
  sourceStep: WorkflowStep,
  resolvePluginResultSchema?: (pluginName: string) => ZodType | undefined,
): ZodType | undefined {
  const kind = getStepKind(sourceStep);
  if (kind === StepKinds.SET_STATE) {
    return SET_STATE_RESULT_SCHEMA;
  }
  if (kind === StepKinds.WORKFLOW) {
    return WORKFLOW_REF_RESULT_SCHEMA;
  }
  if (isPluginStep(sourceStep) && resolvePluginResultSchema) {
    return resolvePluginResultSchema(sourceStep.plugin);
  }
  return undefined;
}

/**
 * 静态校验工作流中的 ContextRef：
 * - 工作流 state 引用（WORKFLOW_STATE_REF_ID）：要求已声明 stateSchema，不做祖先校验
 * - 普通 fromStepId：存在、为当前步骤祖先、来源允许被引用
 */
export function validateWorkflowContextReferences(
  workflow: WorkflowDefinition,
  options: ValidateWorkflowContextReferencesOptions = {},
): void {
  const { resolvePluginResultSchema } = options;
  const stepById = new Map<string, WorkflowStep>(workflow.steps.map((s) => [s.id, s]));
  const hasStateSchema = workflow.stateSchema !== undefined;

  for (const step of workflow.steps) {
    const payload = getStepReferencePayload(step);
    const refs = extractContextReferences(payload);
    if (refs.length === 0) continue;

    const ancestors = getAncestorIds(step.id, workflow.steps);

    for (const ref of refs) {
      const { fromStepId } = ref.$ref;

      if (fromStepId === WORKFLOW_STATE_REF_ID) {
        if (!hasStateSchema) {
          throw new WorkflowValidationError(
            `步骤 "${step.id}" 引用了工作流 state，但当前工作流未声明 stateSchema`,
          );
        }
        continue;
      }

      if (!stepById.has(fromStepId)) {
        throw new WorkflowValidationError(
          `步骤 "${step.id}" 的 config 引用了不存在的步骤 "${fromStepId}"`,
        );
      }

      if (!ancestors.has(fromStepId)) {
        throw new WorkflowValidationError(
          `步骤 "${step.id}" 的 config 引用了非祖先步骤 "${fromStepId}"（必须是直接或间接依赖）`,
        );
      }

      const sourceStep = stepById.get(fromStepId)!;
      const sourceKind = getStepKind(sourceStep);

      if (resolvePluginResultSchema || sourceKind !== StepKinds.PLUGIN) {
        const schema = resolveStepResultSchema(sourceStep, resolvePluginResultSchema);
        if (!schema) {
          const pluginLabel = isPluginStep(sourceStep) ? `（插件 "${sourceStep.plugin}"）` : '';
          throw new WorkflowValidationError(
            `步骤 "${step.id}" 引用了步骤 "${fromStepId}"${pluginLabel}，但该步骤未声明 resultSchema`,
          );
        }
      }
    }
  }
}
