import { HttpException } from '@nestjs/common';
import { PluginsService } from './plugins.service.js';
import type { EngineService } from '../engine/engine.service.js';

describe('PluginsService', () => {
  const mockEngineService = {
    getPlugins: jest.fn(),
    getPlugin: jest.fn(),
    getPluginConfigJsonSchema: jest.fn(),
    getAllPluginConfigJsonSchemas: jest.fn(),
    dryRunPlugin: jest.fn(),
  };

  const service = new PluginsService(mockEngineService as unknown as EngineService);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('listConfigSchemas', () => {
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
      mockEngineService.getAllPluginConfigJsonSchemas.mockReturnValue(schemas);

      const result = service.listConfigSchemas();

      expect(result).toEqual(schemas);
      expect(mockEngineService.getAllPluginConfigJsonSchemas).toHaveBeenCalled();
    });
  });

  describe('getConfigSchema', () => {
    it('returns name and configJsonSchema when plugin has schema', () => {
      const configJsonSchema = {
        type: 'object',
        properties: { type: { type: 'string', enum: ['unit'] } },
      };
      mockEngineService.getPluginConfigJsonSchema.mockReturnValue(configJsonSchema);

      const result = service.getConfigSchema('test-plugin');

      expect(result).toEqual({
        name: 'test-plugin',
        configJsonSchema,
      });
      expect(mockEngineService.getPluginConfigJsonSchema).toHaveBeenCalledWith('test-plugin');
    });

    it('throws 404 when plugin is missing or has no configSchema', () => {
      mockEngineService.getPluginConfigJsonSchema.mockReturnValue(undefined);

      expect(() => service.getConfigSchema('missing-plugin')).toThrow(HttpException);
      expect(() => service.getConfigSchema('missing-plugin')).toThrow(
        '插件不存在或未声明 configSchema',
      );
    });
  });
});
