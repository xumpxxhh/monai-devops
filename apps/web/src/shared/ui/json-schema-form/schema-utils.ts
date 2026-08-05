import type { ContextRef } from '@monai-devops/core-engine';
import type { ConfigReferenceSource, JsonObjectSchema, JsonSchemaProperty } from './types';
import { isContextRef, schemaBasicTypeLabel } from './context-ref';

export function humanizeFieldLabel(key: string, description?: string): string {
  if (description?.trim()) return description.trim();
  return key;
}

export function isSensitiveField(key: string): boolean {
  return /(?:^|_)(apiKey|api_key|password|secret|token)(?:$|_)/i.test(key);
}

/** 沿 path 下钻 JSON Schema；无法解析（union / 缺段）时返回 undefined */
export function resolveSchemaAtPath(
  root: JsonObjectSchema | JsonSchemaProperty,
  path: string[],
): JsonSchemaProperty | undefined {
  let current: JsonObjectSchema | JsonSchemaProperty = root;

  for (const segment of path) {
    if (current.oneOf || current.anyOf) return undefined;

    if (current.type === 'array' || current.items) {
      if (!/^\d+$/.test(segment) || !current.items) return undefined;
      current = current.items;
      continue;
    }

    if (current.type === 'object' || current.properties) {
      const next = current.properties?.[segment];
      if (!next) return undefined;
      current = next;
      continue;
    }

    return undefined;
  }

  return current;
}

/** 期望类型与引用源类型是否兼容（unknown/union 视为可接受） */
export function areJsonTypesCompatible(
  expected: string | undefined,
  actual: string | undefined,
): boolean {
  if (!expected || expected === 'unknown' || expected === 'union') return true;
  if (!actual || actual === 'unknown' || actual === 'union') return true;
  if (expected === actual) return true;
  if (
    (expected === 'number' && actual === 'integer') ||
    (expected === 'integer' && actual === 'number')
  ) {
    return true;
  }
  return false;
}

export function validateContextRefType(
  expectedProp: JsonSchemaProperty,
  ref: ContextRef,
  sources: ConfigReferenceSource[],
): string | undefined {
  const source = sources.find((s) => s.stepId === ref.$ref.fromStepId);
  if (!source) {
    return '引用的上游不存在或不可用';
  }
  const actualSchema = resolveSchemaAtPath(source.resultSchema, ref.$ref.path);
  if (!actualSchema) {
    return '无法解析引用路径的类型';
  }
  const expected = schemaBasicTypeLabel(expectedProp);
  const actual = schemaBasicTypeLabel(actualSchema);
  if (!areJsonTypesCompatible(expected, actual)) {
    return `类型不匹配：字段为 ${expected}，引用为 ${actual}`;
  }
  return undefined;
}

export function buildDefaultValues(schema: JsonObjectSchema): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const properties = schema.properties ?? {};

  for (const [key, prop] of Object.entries(properties)) {
    if (prop.default !== undefined) {
      result[key] = prop.default;
      continue;
    }
    if (prop.enum?.length) {
      result[key] = prop.enum[0];
      continue;
    }
    if (prop.type === 'boolean') {
      result[key] = false;
      continue;
    }
    if (prop.type === 'number' || prop.type === 'integer') {
      result[key] = '';
      continue;
    }
    if (prop.type === 'object') {
      result[key] = {};
      continue;
    }
    if (prop.type === 'array') {
      result[key] = [];
      continue;
    }
    result[key] = '';
  }

  return result;
}

export function mergeWithDefaults(
  schema: JsonObjectSchema,
  value: Record<string, unknown>,
): Record<string, unknown> {
  return { ...buildDefaultValues(schema), ...value };
}

/** 仅合并 JSON Schema 声明的 default，不填充 enum 首项（与运行时 Zod 校验对齐） */
export function mergeSchemaDeclaredDefaults(
  schema: JsonObjectSchema,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...value };
  const properties = schema.properties ?? {};

  for (const [key, prop] of Object.entries(properties)) {
    if (isContextRef(merged[key])) continue;
    if (prop.default !== undefined && (merged[key] === undefined || merged[key] === null)) {
      merged[key] = prop.default;
    }
  }

  return merged;
}

export interface ValidateAgainstSchemaOptions {
  referenceSources?: ConfigReferenceSource[];
}

export function validateAgainstSchema(
  schema: JsonObjectSchema,
  value: Record<string, unknown>,
  options: ValidateAgainstSchemaOptions = {},
): Record<string, string> {
  const errors: Record<string, string> = {};
  const required = schema.required ?? [];
  const properties = schema.properties ?? {};
  const sources = options.referenceSources;

  for (const key of required) {
    const fieldValue = value[key];
    if (isContextRef(fieldValue)) continue;
    if (fieldValue === undefined || fieldValue === null || fieldValue === '') {
      errors[key] = '必填项';
    }
  }

  for (const [key, prop] of Object.entries(properties)) {
    const fieldValue = value[key];
    if (fieldValue === undefined || fieldValue === null || fieldValue === '') {
      continue;
    }

    if (isContextRef(fieldValue)) {
      if (sources?.length) {
        const refError = validateContextRefType(prop, fieldValue, sources);
        if (refError) errors[key] = refError;
      }
      continue;
    }

    if (prop.enum?.length) {
      const matched = prop.enum.some(
        (item) => item === fieldValue || String(item) === String(fieldValue),
      );
      if (!matched) {
        errors[key] = '无效选项';
        continue;
      }
    }

    if (prop.type === 'string') {
      if (typeof fieldValue !== 'string') {
        errors[key] = '须为字符串';
      } else if (prop.minLength !== undefined && fieldValue.length < prop.minLength) {
        errors[key] = `至少 ${prop.minLength} 个字符`;
      }
      continue;
    }

    if (prop.type === 'number' || prop.type === 'integer') {
      const n = typeof fieldValue === 'number' ? fieldValue : Number(fieldValue);
      if (typeof fieldValue !== 'number' && typeof fieldValue !== 'string') {
        errors[key] = '请输入有效数字';
      } else if (!Number.isFinite(n)) {
        errors[key] = '请输入有效数字';
      } else if (prop.type === 'integer' && !Number.isInteger(n)) {
        errors[key] = '请输入整数';
      }
      continue;
    }

    if (prop.type === 'object') {
      if (typeof fieldValue !== 'object' || fieldValue === null || Array.isArray(fieldValue)) {
        errors[key] = '须为 JSON 对象';
      }
      continue;
    }

    if (prop.type === 'array') {
      if (!Array.isArray(fieldValue)) {
        errors[key] = '须为 JSON 数组';
      }
      continue;
    }

    if (prop.type === 'boolean') {
      if (typeof fieldValue !== 'boolean') {
        errors[key] = '须为布尔值';
      }
    }
  }

  return errors;
}

export function coerceValidatedValues(
  schema: JsonObjectSchema,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const properties = schema.properties ?? {};
  const result: Record<string, unknown> = {};

  for (const [key, prop] of Object.entries(properties)) {
    const fieldValue = value[key];
    if (fieldValue === undefined || fieldValue === null || fieldValue === '') {
      continue;
    }

    if (isContextRef(fieldValue)) {
      result[key] = fieldValue;
      continue;
    }

    if (prop.enum?.length) {
      const matched = prop.enum.find(
        (item) => item === fieldValue || String(item) === String(fieldValue),
      );
      result[key] = matched !== undefined ? matched : fieldValue;
      continue;
    }

    if (prop.type === 'number' || prop.type === 'integer') {
      result[key] = Number(fieldValue);
      continue;
    }

    if (prop.type === 'boolean') {
      result[key] = fieldValue;
      continue;
    }

    if (prop.type === 'string') {
      result[key] = typeof fieldValue === 'string' ? fieldValue : String(fieldValue);
      continue;
    }

    if (prop.type === 'object' || prop.type === 'array') {
      result[key] = fieldValue;
      continue;
    }

    result[key] = fieldValue;
  }

  return result;
}

/** 手填模式切换时的默认字面量 */
export function literalFallbackForProp(prop: JsonSchemaProperty): unknown {
  if (prop.default !== undefined) return prop.default;
  if (prop.enum?.[0] !== undefined) return prop.enum[0];
  if (prop.type === 'boolean') return false;
  if (prop.type === 'object') return {};
  if (prop.type === 'array') return [];
  if (prop.type === 'number' || prop.type === 'integer') return '';
  return '';
}
