import { randomUUID } from 'node:crypto';
import type { WorkflowDefinition, WorkflowStep } from '@monai-devops/core-engine';
import { WorkflowValidationError } from '@monai-devops/core-engine';

export interface WorkflowDraftStep {
  clientRef?: string;
  id?: string;
  name: string;
  plugin: string;
  config: WorkflowStep['config'];
  condition?: WorkflowStep['condition'];
  dependsOn?: string[];
  priority?: number;
}

export interface WorkflowDraft {
  id?: string;
  name: string;
  steps: WorkflowDraftStep[];
}

export interface NormalizeWorkflowIdsOptions {
  /** update 时由路径参数提供 */
  workflowId?: string;
  /** update 时已有步骤 id，保留匹配项 */
  knownStepIds?: Set<string>;
}

function resolveWorkflowId(draft: WorkflowDraft, workflowId?: string): string {
  if (workflowId?.trim()) {
    return workflowId.trim();
  }
  if (draft.id?.trim()) {
    return draft.id.trim();
  }
  return randomUUID();
}

function shouldKeepStepId(stepId: string | undefined, knownStepIds?: Set<string>): boolean {
  if (!stepId?.trim() || !knownStepIds?.size) {
    return false;
  }
  return knownStepIds.has(stepId.trim());
}

function resolveDependsOn(
  dependsOn: string[] | undefined,
  refMap: Map<string, string>,
  stepLabel: string,
): string[] | undefined {
  if (!dependsOn?.length) {
    return dependsOn;
  }

  return dependsOn.map((dep) => {
    const resolved = refMap.get(dep);
    if (!resolved) {
      throw new WorkflowValidationError(
        `步骤 ${stepLabel} 的依赖 ${dep} 无法解析（非已知步骤 id 或 clientRef）`,
      );
    }
    return resolved;
  });
}

export function normalizeWorkflowIds(
  draft: WorkflowDraft,
  options: NormalizeWorkflowIdsOptions = {},
): WorkflowDefinition {
  const workflowId = resolveWorkflowId(draft, options.workflowId);
  const knownStepIds = options.knownStepIds;

  const assigned = draft.steps.map((step) => {
    const keepId = shouldKeepStepId(step.id, knownStepIds);
    const finalId = keepId ? step.id!.trim() : randomUUID();
    return { step, finalId };
  });

  const refMap = new Map<string, string>();
  for (const { step, finalId } of assigned) {
    refMap.set(finalId, finalId);
    if (step.clientRef?.trim()) {
      refMap.set(step.clientRef.trim(), finalId);
    }
    if (step.id?.trim()) {
      refMap.set(step.id.trim(), finalId);
    }
  }

  const steps: WorkflowStep[] = assigned.map(({ step, finalId }) => {
    const { clientRef: _clientRef, id: _stepId, ...rest } = step;
    void _clientRef;
    void _stepId;
    return {
      ...rest,
      id: finalId,
      dependsOn: resolveDependsOn(step.dependsOn, refMap, step.name || finalId),
    };
  });

  return {
    id: workflowId,
    name: draft.name,
    steps,
  };
}
