/**
 * 工作流嵌套静态校验：深度、引用环、循环嵌循环
 * @module executor/workflow-nesting
 */

import { WorkflowValidationError } from '../errors.js';
import {
  isWorkflowRefStep,
  type ResolveWorkflow,
  type WorkflowDefinition,
  type WorkflowRefStep,
  type WorkflowStep,
} from './types.js';

const DEFAULT_MAX_NESTING_DEPTH = 3;

export interface ValidateWorkflowNestingOptions {
  /** 嵌套深度上限，默认 3 */
  maxNestingDepth?: number;
  /**
   * 解析 importId → 子工作流定义。
   * 保存侧（server）应注入查库实现；不提供时仅跳过需展开子图的检查。
   */
  resolveWorkflow?: ResolveWorkflow;
  /** 祖先工作流 id 链（含当前），默认 [workflow.id] */
  ancestorWorkflowIds?: string[];
  /** 当前嵌套深度（相对校验起点），默认 0 */
  nestingDepth?: number;
  /**
   * 当前是否处于「带 loop 的 workflow 步骤」之下。
   * 若为 true，本定义内不得再出现带 loop 的 workflow 步骤。
   */
  insideLoop?: boolean;
}

function workflowStepsWithRef(steps: WorkflowStep[]): WorkflowRefStep[] {
  return steps.filter(isWorkflowRefStep);
}

function hasLoopedWorkflowStep(definition: WorkflowDefinition): boolean {
  return workflowStepsWithRef(definition.steps).some((step) => step.loop !== undefined);
}

/**
 * 校验工作流嵌套约束（可在保存期或执行前调用）：
 * - 嵌套深度 ≤ maxNestingDepth
 * - 禁止循环嵌套循环（带 loop 的引用之下，子定义不得再含带 loop 的 workflow 步骤）
 * - 禁止经 importId 解析得到的 workflowId 落在祖先链上（引用环）
 *
 * 无 `resolveWorkflow` 时：只做本定义内的「insideLoop」拦截，不展开子图。
 */
export async function validateWorkflowNesting(
  workflow: WorkflowDefinition,
  options: ValidateWorkflowNestingOptions = {},
): Promise<void> {
  const maxNestingDepth = options.maxNestingDepth ?? DEFAULT_MAX_NESTING_DEPTH;
  const nestingDepth = options.nestingDepth ?? 0;
  const ancestorWorkflowIds = options.ancestorWorkflowIds ?? (workflow.id ? [workflow.id] : []);
  const insideLoop = options.insideLoop ?? false;
  const resolveWorkflow = options.resolveWorkflow;

  if (insideLoop && hasLoopedWorkflowStep(workflow)) {
    const bad = workflowStepsWithRef(workflow.steps).find((s) => s.loop !== undefined);
    throw new WorkflowValidationError(
      `禁止循环嵌套循环：工作流 "${workflow.id}" 的步骤 "${bad?.id ?? '?'}" 配置了 loop，但处于另一循环引用之下`,
    );
  }

  if (!resolveWorkflow) {
    return;
  }

  for (const step of workflowStepsWithRef(workflow.steps)) {
    const childDepth = nestingDepth + 1;
    if (childDepth > maxNestingDepth) {
      throw new WorkflowValidationError(
        `步骤 "${step.id}" 嵌套深度 ${childDepth} 超过上限 ${maxNestingDepth}`,
      );
    }

    const child = await resolveWorkflow(step.workflowRef.importId);
    if (ancestorWorkflowIds.includes(child.id)) {
      throw new WorkflowValidationError(`步骤 "${step.id}" 引用工作流 "${child.id}" 形成引用环`);
    }

    const stepInsideLoop = insideLoop || step.loop !== undefined;
    if (stepInsideLoop && hasLoopedWorkflowStep(child)) {
      const bad = workflowStepsWithRef(child.steps).find((s) => s.loop !== undefined);
      throw new WorkflowValidationError(
        `禁止循环嵌套循环：步骤 "${step.id}" 带 loop，但其引用的工作流 "${child.id}" 含带 loop 的步骤 "${bad?.id ?? '?'}"`,
      );
    }

    await validateWorkflowNesting(child, {
      maxNestingDepth,
      resolveWorkflow,
      nestingDepth: childDepth,
      ancestorWorkflowIds: [...ancestorWorkflowIds, child.id],
      insideLoop: stepInsideLoop,
    });
  }
}
