import type { JsonObjectSchema } from './types';

export function humanizeFieldLabel(key: string, description?: string): string {
  if (description?.trim()) return description.trim();
  return key;
}

export function isSensitiveField(key: string): boolean {
  return /(?:^|_)(apiKey|api_key|password|secret|token)(?:$|_)/i.test(key);
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
    if (prop.default !== undefined && (merged[key] === undefined || merged[key] === null)) {
      merged[key] = prop.default;
    }
  }

  return merged;
}

export function validateAgainstSchema(
  schema: JsonObjectSchema,
  value: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const required = schema.required ?? [];
  const properties = schema.properties ?? {};

  for (const key of required) {
    const fieldValue = value[key];
    if (fieldValue === undefined || fieldValue === null || fieldValue === '') {
      errors[key] = '必填项';
    }
  }

  for (const [key, prop] of Object.entries(properties)) {
    const fieldValue = value[key];
    if (fieldValue === undefined || fieldValue === null || fieldValue === '') {
      continue;
    }

    if (prop.type === 'string' && typeof fieldValue === 'string') {
      if (prop.minLength !== undefined && fieldValue.length < prop.minLength) {
        errors[key] = `至少 ${prop.minLength} 个字符`;
      }
      if (prop.enum && !prop.enum.includes(fieldValue)) {
        errors[key] = '无效选项';
      }
    }

    if ((prop.type === 'number' || prop.type === 'integer') && typeof fieldValue === 'string') {
      if (fieldValue !== '' && Number.isNaN(Number(fieldValue))) {
        errors[key] = '请输入有效数字';
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

    if (prop.type === 'number' || prop.type === 'integer') {
      result[key] = Number(fieldValue);
      continue;
    }

    result[key] = fieldValue;
  }

  return result;
}
