import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from '@monai-devops/plugin-sdk';
import { toPluginConfigJsonSchema } from '../src/plugins/plugin-config-schema.js';
import { PluginsService } from '../src/plugins/plugins.service.js';
import { HttpException } from '@nestjs/common';
import type { EngineService } from '../src/engine/engine.service.js';

const configSchema = z.object({
  type: z.enum(['unit', 'integration', 'e2e']),
});

describe('toPluginConfigJsonSchema', () => {
  it('converts plugin configSchema to JSON Schema object', () => {
    const jsonSchema = toPluginConfigJsonSchema(configSchema);

    assert.equal(jsonSchema.type, 'object');
    const properties = jsonSchema.properties as Record<string, { enum?: string[] }>;
    assert.deepEqual(properties.type.enum, ['unit', 'integration', 'e2e']);
    assert.deepEqual(jsonSchema.required, ['type']);
  });

  it('inlines schema without $ref when using none strategy', () => {
    const jsonSchema = toPluginConfigJsonSchema(configSchema);

    assert.equal('ref' in jsonSchema, false);
    assert.equal('$defs' in jsonSchema, false);
  });
});

describe('PluginsService.listConfigSchemas', () => {
  it('returns config schemas for all plugins', () => {
    const schemas = [
      {
        name: 'test-plugin',
        configJsonSchema: {
          type: 'object',
          properties: { type: { type: 'string', enum: ['unit'] } },
        },
      },
      { name: 'no-schema-plugin', configJsonSchema: null },
    ];
    const mockEngineService = {
      getAllPluginConfigJsonSchemas: () => schemas,
    };
    const service = new PluginsService(mockEngineService as unknown as EngineService);

    const result = service.listConfigSchemas();

    assert.deepEqual(result, schemas);
  });
});

describe('PluginsService.getConfigSchema', () => {
  it('returns name and configJsonSchema when plugin has schema', () => {
    const configJsonSchema = {
      type: 'object',
      properties: { type: { type: 'string', enum: ['unit'] } },
    };
    const mockEngineService = {
      getPluginConfigJsonSchema: () => configJsonSchema,
    };
    const service = new PluginsService(mockEngineService as unknown as EngineService);

    const result = service.getConfigSchema('test-plugin');

    assert.deepEqual(result, {
      name: 'test-plugin',
      configJsonSchema,
    });
  });

  it('throws 404 when plugin is missing or has no configSchema', () => {
    const mockEngineService = {
      getPluginConfigJsonSchema: () => undefined,
    };
    const service = new PluginsService(mockEngineService as unknown as EngineService);

    assert.throws(
      () => service.getConfigSchema('missing-plugin'),
      (error: unknown) =>
        error instanceof HttpException && error.message === '插件不存在或未声明 configSchema',
    );
  });
});
