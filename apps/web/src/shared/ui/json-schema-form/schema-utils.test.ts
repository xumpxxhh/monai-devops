import { describe, expect, it } from 'vitest';
import {
  buildDefaultValues,
  coerceValidatedValues,
  mergeWithDefaults,
  validateAgainstSchema,
} from './schema-utils';
import type { JsonObjectSchema } from './types';

const testPluginSchema: JsonObjectSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['unit', 'integration', 'e2e'] },
  },
  required: ['type'],
  additionalProperties: false,
};

const modelCallSchema: JsonObjectSchema = {
  type: 'object',
  properties: {
    message: { type: 'string', default: 'Hello from model-call-plugin' },
    apiKey: { type: 'string', minLength: 1 },
  },
  required: ['apiKey'],
  additionalProperties: false,
};

describe('schema-utils', () => {
  it('builds defaults from enum and default fields', () => {
    expect(buildDefaultValues(testPluginSchema)).toEqual({ type: 'unit' });
    expect(buildDefaultValues(modelCallSchema)).toEqual({
      message: 'Hello from model-call-plugin',
      apiKey: '',
    });
  });

  it('merges existing values over defaults', () => {
    expect(mergeWithDefaults(testPluginSchema, { type: 'e2e' })).toEqual({ type: 'e2e' });
  });

  it('validates required and minLength', () => {
    expect(validateAgainstSchema(testPluginSchema, { type: '' })).toEqual({ type: '必填项' });
    expect(validateAgainstSchema(modelCallSchema, { apiKey: '' })).toEqual({ apiKey: '必填项' });
    expect(validateAgainstSchema(modelCallSchema, { apiKey: 'sk-test' })).toEqual({});
  });

  it('coerces numeric fields', () => {
    const schema: JsonObjectSchema = {
      properties: { count: { type: 'integer' } },
    };
    expect(coerceValidatedValues(schema, { count: '3' })).toEqual({ count: 3 });
  });

  it('coerces enum Select string back to original enum type', () => {
    const schema: JsonObjectSchema = {
      properties: { level: { type: 'number', enum: [1, 2, 3] } },
    };
    expect(coerceValidatedValues(schema, { level: '2' })).toEqual({ level: 2 });
  });

  it('rejects non-string values for string fields', () => {
    const schema: JsonObjectSchema = {
      properties: { name: { type: 'string' } },
    };
    expect(validateAgainstSchema(schema, { name: 123 })).toEqual({ name: '须为字符串' });
  });

  it('rejects non-integer for integer fields', () => {
    const schema: JsonObjectSchema = {
      properties: { n: { type: 'integer' } },
    };
    expect(validateAgainstSchema(schema, { n: 1.5 })).toEqual({ n: '请输入整数' });
  });

  it('skips type checks for ContextRef fields and treats them as filled', () => {
    expect(
      validateAgainstSchema(modelCallSchema, {
        apiKey: { $ref: { fromStepId: 'a', path: [] } },
      }),
    ).toEqual({});
  });

  it('validates ContextRef type against referenceSources', () => {
    const schema: JsonObjectSchema = {
      type: 'object',
      properties: { count: { type: 'number' } },
    };
    const sources = [
      {
        stepId: 'up',
        label: 'Up',
        plugin: 'p',
        resultSchema: {
          type: 'object',
          properties: { answer: { type: 'string' }, n: { type: 'number' } },
        },
      },
    ];
    expect(
      validateAgainstSchema(
        schema,
        { count: { $ref: { fromStepId: 'up', path: ['answer'] } } },
        { referenceSources: sources },
      ),
    ).toEqual({ count: '类型不匹配：字段为 number，引用为 string' });
    expect(
      validateAgainstSchema(
        schema,
        { count: { $ref: { fromStepId: 'up', path: ['n'] } } },
        { referenceSources: sources },
      ),
    ).toEqual({});
  });

  it('validates object and array literal shapes', () => {
    const schema: JsonObjectSchema = {
      properties: {
        meta: { type: 'object' },
        tags: { type: 'array' },
      },
    };
    expect(validateAgainstSchema(schema, { meta: 'x', tags: {} })).toEqual({
      meta: '须为 JSON 对象',
      tags: '须为 JSON 数组',
    });
  });

  it('preserves ContextRef in coerceValidatedValues', () => {
    const ref = { $ref: { fromStepId: 'a', path: ['x'] } };
    expect(coerceValidatedValues(modelCallSchema, { apiKey: ref })).toEqual({ apiKey: ref });
  });
});
