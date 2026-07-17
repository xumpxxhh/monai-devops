/** DAG 环检测与节点引用唯一性校验 */
export function validateDag(steps: Array<{ id: string; dependsOn?: string[] }>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const ids = steps.map((s) => s.id);
  const unique = new Set(ids);
  if (unique.size !== ids.length) {
    errors.push('步骤 id 必须唯一');
  }

  const graph = new Map<string, string[]>();
  for (const step of steps) {
    graph.set(step.id, step.dependsOn ?? []);
    for (const dep of step.dependsOn ?? []) {
      if (!unique.has(dep)) {
        errors.push(`步骤 ${step.id} 依赖不存在的步骤 ${dep}`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  function dfs(node: string): boolean {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const dep of graph.get(node) ?? []) {
      if (dfs(dep)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  }

  for (const id of ids) {
    if (dfs(id)) {
      errors.push('工作流存在循环依赖');
      break;
    }
  }

  return { valid: errors.length === 0, errors };
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
