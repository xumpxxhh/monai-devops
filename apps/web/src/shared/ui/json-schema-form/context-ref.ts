import { isContextRef, type ContextRef } from '@monai-devops/core-engine';
import type { JsonObjectSchema, JsonSchemaProperty } from './types';

export type ResultFieldOption = {
  path: string[];
  label: string;
};

export function formatContextRefLabel(ref: ContextRef, stepLabel?: string): string {
  const step = stepLabel ?? ref.$ref.fromStepId;
  const path = ref.$ref.path;
  if (path.length === 0) return `${step} →（整个结果）`;
  const pathLabel = path
    .map((segment) => (/^\d+$/.test(segment) ? `[${segment}]` : segment))
    .join('.')
    .replace(/\.\[/g, '[');
  return `${step} → ${pathLabel}`;
}

/**
 * 从 result JSON Schema 生成可选字段路径。
 * 复杂 oneOf/anyOf 仅提供「整个节点」；数组提供 [0] 示例下钻。
 */
export function buildResultFieldOptions(
  schema: JsonObjectSchema | JsonSchemaProperty,
  prefix: string[] = [],
): ResultFieldOption[] {
  const options: ResultFieldOption[] = [];
  const labelFor = (path: string[]) =>
    path.length === 0
      ? '整个结果'
      : path
          .map((s) => (/^\d+$/.test(s) ? `[${s}]` : s))
          .join('.')
          .replace(/\.\[/g, '[');

  options.push({ path: [...prefix], label: labelFor(prefix) });

  if (schema.oneOf || schema.anyOf) {
    return options;
  }

  if (schema.type === 'object' || schema.properties) {
    for (const [key, prop] of Object.entries(schema.properties ?? {})) {
      options.push(...buildResultFieldOptions(prop, [...prefix, key]));
    }
    return options;
  }

  if (schema.type === 'array' || schema.items) {
    if (schema.items) {
      options.push(...buildResultFieldOptions(schema.items, [...prefix, '0']));
    }
    return options;
  }

  return options;
}

export { isContextRef };
