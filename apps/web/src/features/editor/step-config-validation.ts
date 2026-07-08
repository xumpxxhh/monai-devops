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
    data: { label: string; plugin: string; config?: Record<string, unknown> };
  }>,
  schemaMap: Map<string, JsonObjectSchema | null>,
): StepConfigValidationResult {
  const issues: StepConfigIssue[] = [];

  for (const node of nodes) {
    const result = validateStepConfig(node.data.plugin, node.data.config ?? {}, schemaMap);
    if (result.ok === false) {
      issues.push({
        nodeId: node.id,
        stepLabel: node.data.label,
        plugin: node.data.plugin,
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
