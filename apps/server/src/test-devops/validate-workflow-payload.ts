import type { WorkflowDefinition, WorkflowStep } from '@monai-devops/core-engine';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWorkflowStep(value: unknown): value is WorkflowStep {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    typeof value.plugin === 'string' &&
    value.plugin.length > 0 &&
    isRecord(value.config)
  );
}

export function parseRunWorkflowMessage(
  raw: unknown,
): { ok: true; workflow: WorkflowDefinition } | { ok: false; message: string } {
  if (!isRecord(raw) || raw.type !== 'run') {
    return { ok: false, message: '消息格式无效，需要 { type: "run", workflow: {...} }' };
  }

  const workflow = raw.workflow;
  if (!isRecord(workflow)) {
    return { ok: false, message: 'workflow 必须是对象' };
  }

  if (typeof workflow.id !== 'string' || workflow.id.length === 0) {
    return { ok: false, message: 'workflow.id 必须是非空字符串' };
  }

  if (typeof workflow.name !== 'string' || workflow.name.length === 0) {
    return { ok: false, message: 'workflow.name 必须是非空字符串' };
  }

  if (!Array.isArray(workflow.steps) || workflow.steps.length === 0) {
    return { ok: false, message: 'workflow.steps 必须是非空数组' };
  }

  for (const step of workflow.steps) {
    if (!isWorkflowStep(step)) {
      return {
        ok: false,
        message: '每个 step 需要 id、name、plugin（非空字符串）和 config（对象）',
      };
    }
  }

  return {
    ok: true,
    workflow: {
      id: workflow.id,
      name: workflow.name,
      steps: workflow.steps,
    },
  };
}
