import { jest } from '@jest/globals';
import { HttpException, HttpStatus } from '@nestjs/common';
import { PluginsService } from './plugins.service.js';
import type { EngineService } from '../engine/engine.service.js';

describe('PluginsService', () => {
  const mockEngineService = {
    getPlugins: jest.fn(),
    getPlugin: jest.fn(),
    getPluginConfigJsonSchema: jest.fn(),
    getAllPluginConfigJsonSchemas: jest.fn(),
    getPluginResultJsonSchema: jest.fn(),
    getAllPluginResultJsonSchemas: jest.fn(),
    dryRunPlugin: jest.fn(),
    onEvent: jest.fn(() => () => undefined),
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

  describe('listResultSchemas', () => {
    it('returns result schemas for all plugins', () => {
      const schemas = [
        {
          name: 'test-plugin',
          resultJsonSchema: {
            type: 'object',
            properties: { message: { type: 'string' } },
          },
        },
        { name: 'no-schema-plugin', resultJsonSchema: null },
      ];
      mockEngineService.getAllPluginResultJsonSchemas.mockReturnValue(schemas);

      const result = service.listResultSchemas();

      expect(result).toEqual(schemas);
      expect(mockEngineService.getAllPluginResultJsonSchemas).toHaveBeenCalled();
    });
  });

  describe('getResultSchema', () => {
    it('returns name and resultJsonSchema when plugin has schema', () => {
      const resultJsonSchema = {
        type: 'object',
        properties: { message: { type: 'string' } },
      };
      mockEngineService.getPluginResultJsonSchema.mockReturnValue(resultJsonSchema);

      const result = service.getResultSchema('test-plugin');

      expect(result).toEqual({
        name: 'test-plugin',
        resultJsonSchema,
      });
      expect(mockEngineService.getPluginResultJsonSchema).toHaveBeenCalledWith('test-plugin');
    });

    it('throws 404 when plugin is missing or has no resultSchema', () => {
      mockEngineService.getPluginResultJsonSchema.mockReturnValue(undefined);

      expect(() => service.getResultSchema('missing-plugin')).toThrow(HttpException);
      expect(() => service.getResultSchema('missing-plugin')).toThrow(
        '插件不存在或未声明 resultSchema',
      );
    });
  });

  describe('dryRun', () => {
    it('rejects config containing ContextRef before starting SSE', () => {
      mockEngineService.getPlugin.mockReturnValue({ name: 'test-plugin' });

      expect(() =>
        service.dryRun('test-plugin', {
          answer: { $ref: { fromStepId: 'upstream', path: ['answer'] } },
        }),
      ).toThrow(HttpException);

      try {
        service.dryRun('test-plugin', {
          answer: { $ref: { fromStepId: 'upstream', path: ['answer'] } },
        });
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
        expect((error as HttpException).message).toContain('试运行不支持配置中的上游步骤引用');
      }

      expect(mockEngineService.dryRunPlugin).not.toHaveBeenCalled();
    });
  });
});
