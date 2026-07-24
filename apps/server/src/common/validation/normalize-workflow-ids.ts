import { randomUUID } from 'node:crypto';
import {
  getStepKind,
  isContextRef,
  StepKinds,
  type WorkflowDefinition,
  type WorkflowStep,
} from '@monai-devops/core-engine';
import { WorkflowValidationError } from '@monai-devops/core-engine';

export interface WorkflowDraftStep {
  clientRef?: string;
  id?: string;
  name: string;
  kind?: WorkflowStep['kind'];
  plugin?: string;
  config?: Record<string, unknown>;
  patch?: Record<string, unknown>;
  workflowRef?: { importId: string };
  inputState?: unknown;
  loop?: {
    maxIterations: number;
    until?: { when: string; equals?: unknown; exists?: boolean };
  };
  condition?: WorkflowStep['condition'];
  dependsOn?: string[];
  priority?: number;
}

export interface WorkflowDraft {
  id?: string;
  name: string;
  steps: WorkflowDraftStep[];
  stateSchema?: WorkflowDefinition['stateSchema'];
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
 * 将对象树中 ContextRef.fromStepId 经 refMap 重写为规范化后的步骤 id。
 */
function remapContextReferences(
  value: unknown,
  refMap: Map<string, string>,
  stepLabel: string,
): unknown {
  if (isContextRef(value)) {
    const { fromStepId, path } = value.$ref;
    const resolved = refMap.get(fromStepId);
    if (!resolved) {
      throw new WorkflowValidationError(
        `步骤 ${stepLabel} 的引用 ${fromStepId} 无法解析（非已知步骤 id 或 clientRef）`,
      );
    }
    return { $ref: { fromStepId: resolved, path } };
  }

  if (Array.isArray(value)) {
    return value.map((item) => remapContextReferences(item, refMap, stepLabel));
  }

  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = remapContextReferences(nested, refMap, stepLabel);
    }
    return out;
  }

  return value;
}

function normalizeDraftStep(
  step: WorkflowDraftStep,
  finalId: string,
  refMap: Map<string, string>,
): WorkflowStep {
  const stepLabel = step.name || finalId;
  const kind = getStepKind(step as WorkflowStep);
  const base = {
    id: finalId,
    name: step.name,
    ...(step.condition !== undefined ? { condition: step.condition } : {}),
    dependsOn: resolveDependsOn(step.dependsOn, refMap, stepLabel),
    ...(step.priority !== undefined ? { priority: step.priority } : {}),
  };

  if (kind === StepKinds.SET_STATE) {
    return {
      ...base,
      kind: StepKinds.SET_STATE,
      patch: (remapContextReferences(step.patch ?? {}, refMap, stepLabel) ?? {}) as Record<
        string,
        unknown
      >,
    };
  }

  if (kind === StepKinds.WORKFLOW) {
    const importId = step.workflowRef?.importId?.trim();
    if (!importId) {
      throw new WorkflowValidationError(`步骤 ${stepLabel} 缺少 workflowRef.importId`);
    }
    return {
      ...base,
      kind: StepKinds.WORKFLOW,
      workflowRef: { importId },
      ...(step.inputState !== undefined
        ? { inputState: remapContextReferences(step.inputState, refMap, stepLabel) }
        : {}),
      ...(step.loop !== undefined ? { loop: step.loop } : {}),
    };
  }

  if (!step.plugin?.trim()) {
    throw new WorkflowValidationError(`步骤 ${stepLabel} 缺少 plugin`);
  }
  if (!step.config || typeof step.config !== 'object') {
    throw new WorkflowValidationError(`步骤 ${stepLabel} 的 config 必须是对象`);
  }

  return {
    ...base,
    ...(step.kind !== undefined ? { kind: StepKinds.PLUGIN } : {}),
    plugin: step.plugin.trim(),
    config: remapContextReferences(step.config, refMap, stepLabel) as Record<string, unknown>,
  };
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

  const steps: WorkflowStep[] = assigned.map(({ step, finalId }) =>
    normalizeDraftStep(step, finalId, refMap),
  );

  return {
    id: workflowId,
    name: draft.name,
    steps,
    ...(draft.stateSchema !== undefined ? { stateSchema: draft.stateSchema } : {}),
  };
}
