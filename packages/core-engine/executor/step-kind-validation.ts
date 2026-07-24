/**
 * 步骤形态与 state 相关静态校验
 * @module executor/step-kind-validation
 */

import { WorkflowValidationError } from '../errors.js';
import {
  getStepKind,
  isSetStateStep,
  isWorkflowRefStep,
  StepKinds,
  type WorkflowDefinition,
  type WorkflowStep,
} from './types.js';
import { StateSchemaConversionError, jsonSchemaToZod } from './state-schema.js';

/**
 * 校验步骤 kind 字段完整性与 stateSchema 约束：
 * - set_state 要求工作流已声明 stateSchema，且 patch 为对象
 * - workflow 要求 workflowRef.importId 非空；loop.maxIterations > 0
 * - 未声明 stateSchema 时不允许 loop.until
 * - stateSchema 若存在必须能转为 Zod
 */
export function validateStepKinds(workflow: WorkflowDefinition): void {
  if (workflow.stateSchema !== undefined) {
    try {
      jsonSchemaToZod(workflow.stateSchema);
    } catch (error) {
      const message =
        error instanceof StateSchemaConversionError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      throw new WorkflowValidationError(`stateSchema 无法转换为 Zod：${message}`);
    }
  }

  const hasStateSchema = workflow.stateSchema !== undefined;

  for (const step of workflow.steps) {
    const kind = getStepKind(step);

    if (kind === StepKinds.SET_STATE) {
      if (!hasStateSchema) {
        throw new WorkflowValidationError(
          `步骤 "${step.id}" 为 set_state，但工作流未声明 stateSchema`,
        );
      }
      if (!isSetStateStep(step)) {
        throw new WorkflowValidationError(`步骤 "${step.id}" kind 为 set_state 但缺少 patch`);
      }
      if (typeof step.patch !== 'object' || step.patch === null || Array.isArray(step.patch)) {
        throw new WorkflowValidationError(`步骤 "${step.id}" 的 patch 必须是对象`);
      }
      continue;
    }

    if (kind === StepKinds.WORKFLOW) {
      if (!isWorkflowRefStep(step)) {
        throw new WorkflowValidationError(`步骤 "${step.id}" kind 为 workflow 但缺少 workflowRef`);
      }
      const importId = step.workflowRef?.importId;
      if (typeof importId !== 'string' || importId.trim().length === 0) {
        throw new WorkflowValidationError(
          `步骤 "${step.id}" 的 workflowRef.importId 必须为非空字符串`,
        );
      }
      if (step.loop !== undefined) {
        if (
          typeof step.loop.maxIterations !== 'number' ||
          !Number.isInteger(step.loop.maxIterations) ||
          step.loop.maxIterations <= 0
        ) {
          throw new WorkflowValidationError(`步骤 "${step.id}" 的 loop.maxIterations 必须为正整数`);
        }
        // until 针对被引用工作流的 state；被引用方是否声明 stateSchema 只能在 resolve 后确认。
        // 此处仅校验 until 结构完整性。
        if (step.loop.until !== undefined) {
          if (typeof step.loop.until.when !== 'string' || step.loop.until.when.length === 0) {
            throw new WorkflowValidationError(
              `步骤 "${step.id}" 的 loop.until.when 必须为非空字符串`,
            );
          }
        }
      }
      continue;
    }

    // plugin（默认）
    if (!('plugin' in step) || typeof step.plugin !== 'string' || step.plugin.length === 0) {
      throw new WorkflowValidationError(`步骤 "${step.id}" 缺少 plugin 字段`);
    }
    if (!('config' in step) || typeof step.config !== 'object' || step.config === null) {
      throw new WorkflowValidationError(`步骤 "${step.id}" 缺少 config 字段`);
    }
  }
}

/** 收集步骤上可能含 ContextRef 的配置载荷 */
export function getStepReferencePayload(step: WorkflowStep): unknown {
  const kind = getStepKind(step);
  if (kind === StepKinds.SET_STATE && isSetStateStep(step)) {
    return step.patch;
  }
  if (kind === StepKinds.WORKFLOW && isWorkflowRefStep(step)) {
    return step.inputState;
  }
  if ('config' in step) {
    return step.config;
  }
  return undefined;
}
