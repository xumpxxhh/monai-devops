import {
  validateDag as validateDagCore,
  WorkflowValidationError,
  type WorkflowStep,
} from '@monai-devops/core-engine';

/** DAG 环检测与节点引用唯一性校验（复用 core-engine validateDag） */
export function validateDag(steps: Array<{ id: string; dependsOn?: string[] }>): {
  valid: boolean;
  errors: string[];
} {
  try {
    const engineSteps = steps.map(
      (step) =>
        ({
          id: step.id,
          name: step.id,
          plugin: '_dag',
          config: {},
          dependsOn: step.dependsOn,
        }) satisfies WorkflowStep,
    );
    validateDagCore(engineSteps);
    return { valid: true, errors: [] };
  } catch (error) {
    if (error instanceof WorkflowValidationError) {
      return { valid: false, errors: [error.message] };
    }
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : '工作流结构不合法'],
    };
  }
}

/** 沿 dependsOn 反向收集祖先 stepId（不含自身） */
export function getAncestorIds(
  nodeId: string,
  steps: Array<{ id: string; dependsOn?: string[] }>,
): Set<string> {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const ancestors = new Set<string>();
  const stack = [...(byId.get(nodeId)?.dependsOn ?? [])];

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
