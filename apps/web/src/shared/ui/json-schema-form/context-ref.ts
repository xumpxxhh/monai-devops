import { isContextRef, type ContextRef } from '@monai-devops/core-engine';
import type { JsonObjectSchema, JsonSchemaProperty } from './types';

export type ResultFieldOption = {
  path: string[];
  label: string;
};

/** 级联选择器用的树节点（value 为路径段） */
export type ResultFieldTreeNode = {
  value: string;
  label: string;
  /** 基本类型标注，如 string / number / object / array */
  typeLabel?: string;
  children?: ResultFieldTreeNode[];
};

/** 根节点「整个结果」的哨兵 value；选中后映射为 path [] */
export const RESULT_ROOT_VALUE = '__entire__';

/** 从 JSON Schema 提取用于展示的基本类型名 */
export function schemaBasicTypeLabel(schema: JsonObjectSchema | JsonSchemaProperty): string {
  if (schema.oneOf || schema.anyOf) return 'union';
  if (schema.type === 'array' || schema.items) return 'array';
  if (schema.type === 'object' || schema.properties) return 'object';
  if (schema.type === 'integer') return 'integer';
  if (
    schema.type === 'string' ||
    schema.type === 'number' ||
    schema.type === 'boolean' ||
    schema.type === 'null'
  ) {
    return schema.type;
  }
  if (schema.enum?.length) {
    const sample = schema.enum[0];
    if (typeof sample === 'string') return 'string';
    if (typeof sample === 'number') return 'number';
    if (typeof sample === 'boolean') return 'boolean';
  }
  return 'unknown';
}

export function formatResultPathLabel(path: string[]): string {
  if (path.length === 0) return '整个结果';
  return path
    .map((s) => (/^\d+$/.test(s) ? `[${s}]` : s))
    .join('.')
    .replace(/\.\[/g, '[');
}

export function formatContextRefLabel(ref: ContextRef, stepLabel?: string): string {
  const step = stepLabel ?? ref.$ref.fromStepId;
  const path = ref.$ref.path;
  if (path.length === 0) return `${step} →（整个结果）`;
  return `${step} → ${formatResultPathLabel(path)}`;
}

/** Cascader 选中值 ↔ `$ref.path` */
export function pathToCascaderValue(path: string[]): string[] {
  return path.length === 0 ? [RESULT_ROOT_VALUE] : path;
}

export function cascaderValueToPath(value: string[]): string[] {
  if (value.length === 1 && value[0] === RESULT_ROOT_VALUE) return [];
  return value;
}

function buildTreeChildren(schema: JsonObjectSchema | JsonSchemaProperty): ResultFieldTreeNode[] {
  if (schema.oneOf || schema.anyOf) {
    return [];
  }

  if (schema.type === 'object' || schema.properties) {
    return Object.entries(schema.properties ?? {}).map(([key, prop]) => {
      const children = buildTreeChildren(prop);
      return {
        value: key,
        label: key,
        typeLabel: schemaBasicTypeLabel(prop),
        children: children.length > 0 ? children : undefined,
      };
    });
  }

  if (schema.type === 'array' || schema.items) {
    if (!schema.items) return [];
    const children = buildTreeChildren(schema.items);
    return [
      {
        value: '0',
        label: '[0]',
        typeLabel: schemaBasicTypeLabel(schema.items),
        children: children.length > 0 ? children : undefined,
      },
    ];
  }

  return [];
}

/**
 * 从 result JSON Schema 生成级联树。
 * 含「整个结果」根项；含 children 的节点也可选（changeOnSelect）。
 * 复杂 oneOf/anyOf 仅提供「整个节点」；数组提供 [0] 示例下钻。
 */
export function buildResultFieldTree(
  schema: JsonObjectSchema | JsonSchemaProperty,
): ResultFieldTreeNode[] {
  return [
    {
      value: RESULT_ROOT_VALUE,
      label: '整个结果',
      typeLabel: schemaBasicTypeLabel(schema),
    },
    ...buildTreeChildren(schema),
  ];
}

/**
 * 从 result JSON Schema 生成可选字段路径（扁平列表）。
 * 复杂 oneOf/anyOf 仅提供「整个节点」；数组提供 [0] 示例下钻。
 */
export function buildResultFieldOptions(
  schema: JsonObjectSchema | JsonSchemaProperty,
  prefix: string[] = [],
): ResultFieldOption[] {
  const options: ResultFieldOption[] = [];

  options.push({ path: [...prefix], label: formatResultPathLabel(prefix) });

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
