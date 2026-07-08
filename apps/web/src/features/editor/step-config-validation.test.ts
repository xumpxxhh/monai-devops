import { describe, expect, it } from 'vitest';
import type { JsonObjectSchema } from '../../shared/ui/json-schema-form/types';
import {
  formatStepConfigIssues,
  validateAllStepConfigs,
  validateStepConfig,
} from './step-config-validation';

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

function createSchemaMap() {
  return new Map<string, JsonObjectSchema | null>([
    ['test-plugin', testPluginSchema],
    ['model-call-plugin', modelCallSchema],
    ['no-schema-plugin', null],
  ]);
}

describe('validateStepConfig', () => {
  it('fails when test-plugin is missing type', () => {
    const result = validateStepConfig('test-plugin', {}, createSchemaMap());
    expect(result).toEqual({
      ok: false,
      fieldErrors: { type: '必填项' },
    });
  });

  it('fails when test-plugin has invalid type', () => {
    const result = validateStepConfig('test-plugin', { type: 'bad' }, createSchemaMap());
    expect(result).toEqual({
      ok: false,
      fieldErrors: { type: '无效选项' },
    });
  });

  it('fails when model-call-plugin is missing apiKey', () => {
    const result = validateStepConfig('model-call-plugin', {}, createSchemaMap());
    expect(result).toEqual({
      ok: false,
      fieldErrors: { apiKey: '必填项' },
    });
  });

  it('passes model-call-plugin with apiKey only', () => {
    const result = validateStepConfig(
      'model-call-plugin',
      { apiKey: 'sk-test' },
      createSchemaMap(),
    );
    expect(result).toEqual({
      ok: true,
      config: { apiKey: 'sk-test', message: 'Hello from model-call-plugin' },
    });
  });

  it('fails for unknown plugin', () => {
    const result = validateStepConfig('missing-plugin', {}, createSchemaMap());
    expect(result).toEqual({
      ok: false,
      fieldErrors: { _plugin: '插件不存在' },
    });
  });

  it('passes for plugin without schema', () => {
    const result = validateStepConfig('no-schema-plugin', {}, createSchemaMap());
    expect(result).toEqual({ ok: true, config: {} });
  });
});

describe('validateAllStepConfigs', () => {
  it('collects issues from invalid nodes', () => {
    const result = validateAllStepConfigs(
      [
        {
          id: 'n1',
          data: { label: '步骤 1', plugin: 'test-plugin', config: { type: 'unit' } },
        },
        {
          id: 'n2',
          data: { label: '步骤 2', plugin: 'model-call-plugin', config: {} },
        },
      ],
      createSchemaMap(),
    );

    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.nodeId).toBe('n2');
  });
});

describe('formatStepConfigIssues', () => {
  it('formats field errors for display', () => {
    const messages = formatStepConfigIssues([
      {
        nodeId: 'n2',
        stepLabel: '步骤 2',
        plugin: 'model-call-plugin',
        fieldErrors: { apiKey: '必填项' },
      },
    ]);
    expect(messages[0]).toContain('步骤 2');
    expect(messages[0]).toContain('apiKey: 必填项');
  });
});
