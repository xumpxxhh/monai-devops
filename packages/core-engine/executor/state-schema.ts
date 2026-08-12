/**
 * stateSchema（JSON Schema）→ Zod 转换与缓存
 * @module executor/state-schema
 *
 * 覆盖前端表单构建器常见子集：object / string / number / integer / boolean /
 * array / null、properties、required、enum、default、additionalProperties。
 * 不支持的特性在转换时抛错，供保存阶段提前拒绝（§4.5）。
 */

import { z, type ZodType } from '@monai-devops/plugin-sdk';
import type { JsonSchemaObject } from './types.js';

export class StateSchemaConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateSchemaConversionError';
  }
}

/** 弱引用缓存：同一 schema 对象引用命中则复用 ZodType */
const cache = new WeakMap<object, ZodType>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function convertNode(schema: unknown, path: string): ZodType {
  if (!isPlainObject(schema)) {
    throw new StateSchemaConversionError(`${path}: stateSchema 节点必须是对象`);
  }

  if (schema.$ref !== undefined) {
    throw new StateSchemaConversionError(`${path}: 不支持 $ref`);
  }

  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf) || Array.isArray(schema.allOf)) {
    throw new StateSchemaConversionError(`${path}: 暂不支持 anyOf/oneOf/allOf`);
  }

  if (Array.isArray(schema.enum)) {
    const values = schema.enum;
    if (values.length === 0) {
      throw new StateSchemaConversionError(`${path}: enum 不能为空`);
    }
    if (
      !values.every((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    ) {
      throw new StateSchemaConversionError(`${path}: enum 仅支持 string/number/boolean`);
    }
    // z.enum 仅接受 string[]；混合类型用 union of literals
    if (values.every((v) => typeof v === 'string')) {
      return z.enum(values as [string, ...string[]]);
    }
    const literals = values.map((v) => z.literal(v as string | number | boolean));
    if (literals.length === 1) return literals[0]!;
    return z.union(literals as unknown as [ZodType, ZodType, ...ZodType[]]);
  }

  const typeValue = schema.type;
  if (typeValue === undefined) {
    // 无 type 但有 properties → 视为 object
    if (isPlainObject(schema.properties)) {
      return convertObject(schema, path);
    }
    throw new StateSchemaConversionError(`${path}: 缺少 type`);
  }

  if (Array.isArray(typeValue)) {
    throw new StateSchemaConversionError(`${path}: 暂不支持联合 type 数组`);
  }

  switch (typeValue) {
    case 'string':
      return z.string();
    case 'number':
      return z.number();
    case 'integer':
      return z.number().int();
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();
    case 'array': {
      const items = schema.items;
      if (items === undefined) {
        return z.array(z.unknown());
      }
      return z.array(convertNode(items, `${path}.items`));
    }
    case 'object':
      return convertObject(schema, path);
    default:
      throw new StateSchemaConversionError(`${path}: 不支持的 type "${String(typeValue)}"`);
  }
}

function convertObject(schema: Record<string, unknown>, path: string): ZodType {
  const properties = schema.properties;
  const shape: Record<string, ZodType> = {};

  if (properties !== undefined) {
    if (!isPlainObject(properties)) {
      throw new StateSchemaConversionError(`${path}.properties 必须是对象`);
    }
    for (const [key, propSchema] of Object.entries(properties)) {
      shape[key] = convertNode(propSchema, `${path}.properties.${key}`);
    }
  }

  const required = Array.isArray(schema.required)
    ? schema.required.filter((k): k is string => typeof k === 'string')
    : [];

  const requiredSet = new Set(required);
  const zodShape: Record<string, ZodType> = {};
  for (const [key, zodType] of Object.entries(shape)) {
    zodShape[key] = requiredSet.has(key) ? zodType : zodType.optional();
  }

  // required 中出现但 properties 未声明的字段 → 拒绝
  for (const key of requiredSet) {
    if (!(key in zodShape)) {
      throw new StateSchemaConversionError(
        `${path}: required 含未在 properties 中声明的字段 "${key}"`,
      );
    }
  }

  let objectSchema: ZodType = z.object(zodShape);

  if (schema.additionalProperties === false) {
    objectSchema = z.object(zodShape).strict();
  } else if (isPlainObject(schema.additionalProperties)) {
    objectSchema = z
      .object(zodShape)
      .catchall(convertNode(schema.additionalProperties, `${path}.additionalProperties`));
  } else if (schema.additionalProperties === true) {
    objectSchema = z.object(zodShape).passthrough();
  }

  if ('default' in schema) {
    return objectSchema.default(schema.default as never);
  }

  return objectSchema;
}

/**
 * 将 JSON Schema 转为 ZodType。转换失败抛 StateSchemaConversionError。
 * 同一 schema 对象引用会缓存结果。
 */
export function jsonSchemaToZod(schema: JsonSchemaObject): ZodType {
  const cached = cache.get(schema);
  if (cached) return cached;

  const zodType = convertNode(schema, 'stateSchema');
  cache.set(schema, zodType);
  return zodType;
}

/**
 * 校验 state；失败返回 ZodError 可读信息，成功返回解析后的值。
 */
export function parseState(
  schema: JsonSchemaObject,
  value: unknown,
): { success: true; data: unknown } | { success: false; message: string } {
  try {
    const zodType = jsonSchemaToZod(schema);
    const result = zodType.safeParse(value);
    if (result.success) {
      return { success: true, data: result.data };
    }
    const message = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { success: false, message: message || 'state 不符合 stateSchema' };
  } catch (error) {
    if (error instanceof StateSchemaConversionError) {
      return { success: false, message: error.message };
    }
    throw error;
  }
}

/** 尝试从 schema 取 default；无则返回 {} */
export function defaultStateFromSchema(schema: JsonSchemaObject): unknown {
  if ('default' in schema) {
    return schema.default;
  }
  try {
    const zodType = jsonSchemaToZod(schema);
    const result = zodType.safeParse(undefined);
    if (result.success) return result.data;
  } catch {
    // ignore
  }
  return {};
}
