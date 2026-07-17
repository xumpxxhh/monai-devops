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

  it('skips type checks for ContextRef fields and treats them as filled', () => {
    expect(
      validateAgainstSchema(modelCallSchema, {
        apiKey: { $ref: { fromStepId: 'a', path: [] } },
      }),
    ).toEqual({});
  });

  it('preserves ContextRef in coerceValidatedValues', () => {
    const ref = { $ref: { fromStepId: 'a', path: ['x'] } };
    expect(coerceValidatedValues(modelCallSchema, { apiKey: ref })).toEqual({ apiKey: ref });
  });
});
