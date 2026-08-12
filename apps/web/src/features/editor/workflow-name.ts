export function defaultWorkflowName(): string {
  const shortId = crypto.randomUUID().slice(0, 8);
  return `未命名工作流_${shortId}_${Date.now()}`;
}

export function validateWorkflowName(name: string): string | undefined {
  if (!name.trim()) {
    return '工作流名称不能为空';
  }
  return undefined;
}
