import { describe, expect, it } from 'vitest';
import {
  RESULT_ROOT_VALUE,
  buildResultFieldTree,
  cascaderValueToPath,
  pathToCascaderValue,
  schemaBasicTypeLabel,
} from './context-ref';
import type { JsonObjectSchema } from './types';

describe('schemaBasicTypeLabel', () => {
  it('maps common schema shapes to basic types', () => {
    expect(schemaBasicTypeLabel({ type: 'string' })).toBe('string');
    expect(schemaBasicTypeLabel({ type: 'integer' })).toBe('integer');
    expect(schemaBasicTypeLabel({ type: 'object', properties: {} })).toBe('object');
    expect(schemaBasicTypeLabel({ type: 'array', items: { type: 'string' } })).toBe('array');
    expect(schemaBasicTypeLabel({ oneOf: [{ type: 'string' }] })).toBe('union');
  });
});

describe('buildResultFieldTree', () => {
  it('builds nested object tree with entire-result root and type labels', () => {
    const schema: JsonObjectSchema = {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
        },
      },
    };

    expect(buildResultFieldTree(schema)).toEqual([
      { value: RESULT_ROOT_VALUE, label: '整个结果', typeLabel: 'object' },
      {
        value: 'data',
        label: 'data',
        typeLabel: 'object',
        children: [{ value: 'id', label: 'id', typeLabel: 'string' }],
      },
    ]);
  });

  it('adds [0] child for arrays while keeping parent selectable', () => {
    const schema: JsonObjectSchema = {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
            },
          },
        },
      },
    };

    const tree = buildResultFieldTree(schema);
    const itemsNode = tree.find((n) => n.value === 'items');
    expect(itemsNode).toEqual({
      value: 'items',
      label: 'items',
      typeLabel: 'array',
      children: [
        {
          value: '0',
          label: '[0]',
          typeLabel: 'object',
          children: [{ value: 'name', label: 'name', typeLabel: 'string' }],
        },
      ],
    });
  });

  it('does not drill into oneOf nodes', () => {
    const schema: JsonObjectSchema = {
      type: 'object',
      properties: {
        payload: {
          oneOf: [{ type: 'string' }, { type: 'number' }],
        },
      },
    };

    expect(buildResultFieldTree(schema)).toEqual([
      { value: RESULT_ROOT_VALUE, label: '整个结果', typeLabel: 'object' },
      { value: 'payload', label: 'payload', typeLabel: 'union' },
    ]);
  });
});

describe('path cascader mapping', () => {
  it('round-trips empty path via root sentinel', () => {
    expect(pathToCascaderValue([])).toEqual([RESULT_ROOT_VALUE]);
    expect(cascaderValueToPath([RESULT_ROOT_VALUE])).toEqual([]);
  });

  it('round-trips nested path unchanged', () => {
    const path = ['data', 'id'];
    expect(pathToCascaderValue(path)).toEqual(path);
    expect(cascaderValueToPath(path)).toEqual(path);
  });
});
