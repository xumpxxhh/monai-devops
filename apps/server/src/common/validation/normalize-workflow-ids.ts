import { randomUUID } from 'node:crypto';
import {
  isContextRef,
  type WorkflowDefinition,
  type WorkflowStep,
} from '@monai-devops/core-engine';
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

/**
 * 将 config 中 ContextRef.fromStepId 经 refMap 重写为规范化后的步骤 id。
 * dependsOn 已由 resolveDependsOn 处理；config 内引用必须同步改写，否则 ID 轮换后会校验失败。
 */
function remapConfigContextReferences(
  config: unknown,
  refMap: Map<string, string>,
  stepLabel: string,
): unknown {
  if (isContextRef(config)) {
    const { fromStepId, path } = config.$ref;
    const resolved = refMap.get(fromStepId);
    if (!resolved) {
      throw new WorkflowValidationError(
        `步骤 ${stepLabel} 的 config 引用 ${fromStepId} 无法解析（非已知步骤 id 或 clientRef）`,
      );
    }
    return { $ref: { fromStepId: resolved, path } };
  }

  if (Array.isArray(config)) {
    return config.map((item) => remapConfigContextReferences(item, refMap, stepLabel));
  }

  if (typeof config === 'object' && config !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
      out[key] = remapConfigContextReferences(value, refMap, stepLabel);
    }
    return out;
  }

  return config;
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
    const stepLabel = step.name || finalId;
    return {
      ...rest,
      id: finalId,
      config: remapConfigContextReferences(
        step.config,
        refMap,
        stepLabel,
      ) as WorkflowStep['config'],
      dependsOn: resolveDependsOn(step.dependsOn, refMap, stepLabel),
    };
  });

  return {
    id: workflowId,
    name: draft.name,
    steps,
  };
}
