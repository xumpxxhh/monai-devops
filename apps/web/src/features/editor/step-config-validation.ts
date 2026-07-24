import type { StepKind } from '@monai-devops/core-engine';
import { StepKinds, getStepKind, type WorkflowStep } from '@monai-devops/core-engine';
import type { WorkflowDraftStep } from '../../shared/api/workflows';
import type { JsonObjectSchema } from '../../shared/ui/json-schema-form/types';
import {
  coerceValidatedValues,
  mergeSchemaDeclaredDefaults,
  validateAgainstSchema,
} from '../../shared/ui/json-schema-form/schema-utils';

export type StepConfigIssue = {
  nodeId: string;
  stepLabel: string;
  plugin: string;
  fieldErrors: Record<string, string>;
};

export type StepConfigValidationResult = {
  valid: boolean;
  issues: StepConfigIssue[];
};

export type StepConfigValidateResult =
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; fieldErrors: Record<string, string> };

export type EditorNodeConfigData = {
  label: string;
  kind?: StepKind;
  plugin?: string;
  config?: Record<string, unknown>;
  patch?: Record<string, unknown>;
  workflowRef?: { importId: string };
};

/** 内置步骤合成 resultSchema（供 $ref 路径选择） */
export const BUILTIN_RESULT_SCHEMAS: Record<string, JsonObjectSchema> = {
  [StepKinds.SET_STATE]: {
    type: 'object',
    additionalProperties: true,
  },
  [StepKinds.WORKFLOW]: {
    type: 'object',
    properties: {
      state: {},
      iterations: { type: 'array' },
      iterationCount: { type: 'number' },
    },
  },
};

export function validateStepConfig(
  plugin: string,
  config: Record<string, unknown>,
  schemaMap: Map<string, JsonObjectSchema | null>,
): StepConfigValidateResult {
  if (!schemaMap.has(plugin)) {
    return { ok: false, fieldErrors: { _plugin: '插件不存在' } };
  }

  const schema = schemaMap.get(plugin);
  if (schema === null || schema === undefined) {
    return { ok: true, config };
  }

  const merged = mergeSchemaDeclaredDefaults(schema, config);
  const fieldErrors = validateAgainstSchema(schema, merged);
  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }

  return { ok: true, config: coerceValidatedValues(schema, merged) };
}

export function validateAllStepConfigs(
  nodes: Array<{
    id: string;
    data: EditorNodeConfigData;
  }>,
  schemaMap: Map<string, JsonObjectSchema | null>,
): StepConfigValidationResult {
  const issues: StepConfigIssue[] = [];

  for (const node of nodes) {
    const kind = node.data.kind ?? StepKinds.PLUGIN;
    if (kind !== StepKinds.PLUGIN) continue;

    const plugin = node.data.plugin ?? '';
    const result = validateStepConfig(plugin, node.data.config ?? {}, schemaMap);
    if (result.ok === false) {
      issues.push({
        nodeId: node.id,
        stepLabel: node.data.label,
        plugin,
        fieldErrors: result.fieldErrors,
      });
    }
  }

  return { valid: issues.length === 0, issues };
}

export function formatStepConfigIssues(issues: StepConfigIssue[]): string[] {
  return issues.map((issue) => {
    const fieldMessages = Object.entries(issue.fieldErrors).map(([field, message]) => {
      if (field === '_plugin') return message;
      return `${field}: ${message}`;
    });
    return `「${issue.stepLabel}」(${issue.plugin}) ${fieldMessages.join('、')}`;
  });
}

export type DraftStepNodeData = EditorNodeConfigData & {
  clientRef?: string;
  stepId?: string;
  priority?: number;
  inputState?: unknown;
  loop?: {
    maxIterations: number;
    until?: { when: string; equals?: unknown; exists?: boolean };
  };
};

/** 将画布节点 data 序列化为草稿步骤（判别联合） */
export function nodeDataToDraftStep(
  data: DraftStepNodeData,
  dependsOn: string[],
): WorkflowDraftStep {
  const kind = data.kind ?? StepKinds.PLUGIN;
  const base = {
    clientRef: data.clientRef,
    ...(data.stepId ? { id: data.stepId } : {}),
    name: data.label,
    dependsOn,
    priority: data.priority,
  };

  if (kind === StepKinds.SET_STATE) {
    return {
      ...base,
      kind: StepKinds.SET_STATE,
      patch: data.patch ?? {},
    };
  }

  if (kind === StepKinds.WORKFLOW) {
    return {
      ...base,
      kind: StepKinds.WORKFLOW,
      workflowRef: { importId: data.workflowRef?.importId ?? '' },
      ...(data.inputState !== undefined ? { inputState: data.inputState } : {}),
      ...(data.loop !== undefined ? { loop: data.loop } : {}),
    };
  }

  return {
    ...base,
    kind: StepKinds.PLUGIN,
    plugin: data.plugin ?? '',
    config: data.config ?? {},
  };
}

export function stepKindLabel(
  step: Pick<WorkflowStep, 'kind' | 'name'> & { plugin?: string },
): string {
  const kind = getStepKind(step as WorkflowStep);
  if (kind === StepKinds.SET_STATE) return 'set_state';
  if (kind === StepKinds.WORKFLOW) return 'workflow';
  return step.plugin ?? 'plugin';
}

export function resultSchemaKeyForStep(step: {
  kind?: StepKind;
  plugin?: string;
}): string | undefined {
  const kind = step.kind ?? StepKinds.PLUGIN;
  if (kind === StepKinds.SET_STATE || kind === StepKinds.WORKFLOW) return kind;
  return step.plugin;
}
