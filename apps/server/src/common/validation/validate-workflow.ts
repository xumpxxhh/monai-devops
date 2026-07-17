import type { WorkflowDefinition, WorkflowStep } from '@monai-devops/core-engine';
import {
  validateWorkflowContextReferences,
  WorkflowValidationError,
  type ValidateWorkflowContextReferencesOptions,
} from '@monai-devops/core-engine';

function buildDag(steps: WorkflowStep[]) {
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
    for (const depId of step.dependsOn ?? []) {
      if (!stepById.has(depId)) {
        throw new WorkflowValidationError(`步骤 ${step.id} 依赖不存在的步骤: ${depId}`);
      }
      inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1);
      dependents.get(depId)!.push(step.id);
    }
  }

  return { stepIds: new Set(stepById.keys()), inDegree, dependents };
}

export type ValidateWorkflowDefinitionOptions = ValidateWorkflowContextReferencesOptions;

export function validateWorkflowDefinition(
  workflow: WorkflowDefinition,
  options: ValidateWorkflowDefinitionOptions = {},
): void {
  if (!workflow.id?.trim()) {
    throw new WorkflowValidationError('workflow.id 必须是非空字符串');
  }
  if (!workflow.name?.trim()) {
    throw new WorkflowValidationError('workflow.name 必须是非空字符串');
  }
  if (!Array.isArray(workflow.steps) || workflow.steps.length === 0) {
    throw new WorkflowValidationError('workflow.steps 必须是非空数组');
  }

  for (const step of workflow.steps) {
    if (!step.id?.trim() || !step.name?.trim() || !step.plugin?.trim()) {
      throw new WorkflowValidationError('每个 step 需要非空的 id、name、plugin');
    }
    if (!step.config || typeof step.config !== 'object') {
      throw new WorkflowValidationError(`步骤 ${step.id} 的 config 必须是对象`);
    }
  }

  const graph = buildDag(workflow.steps);
  const degrees = new Map(graph.inDegree);
  const queue: string[] = [];

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

  validateWorkflowContextReferences(workflow, options);
}
