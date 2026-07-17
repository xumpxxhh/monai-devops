/**
 * 基础插件函数
 * @module base
 */

import type { z } from 'zod';
import type { PluginManifest, PluginConfig, PluginContext, PluginResult } from '../types/index.js';
import { PluginCancelledError, PluginFailureCodes } from '../types/index.js';
import type { PluginHooks } from '../hooks/index.js';
import { formatZodError } from '../validation/index.js';

/**
 * 插件执行函数类型（引擎边界）
 */
export type PluginExecuteFn = (
  config: PluginConfig,
  context: PluginContext,
) => Promise<PluginResult>;

/**
 * 插件定义接口
 */
export interface PluginDefinition extends PluginManifest {
  execute: PluginExecuteFn;
  /** 声明的生命周期钩子；有 hooks 时由 createPlugin 编排进 execute */
  hooks?: PluginHooks;
  /** 插件 config schema；有则 createPlugin 在 execute 前校验 */
  configSchema?: z.ZodType;
  /** 描述 PluginResult.data 的结构（供前端选字段 / 工作流引用校验）；不做运行时校验 */
  resultSchema?: z.ZodType;
}

/**
 * createPlugin 入参（带 configSchema）
 */
export interface CreatePluginOptionsWithSchema<T extends z.ZodType> extends PluginManifest {
  configSchema: T;
  execute: (config: z.infer<T>, context: PluginContext) => Promise<PluginResult>;
  hooks?: PluginHooks<z.infer<T>>;
  resultSchema?: z.ZodType;
}

/**
 * createPlugin 入参（无 configSchema，向后兼容）
 */
export interface CreatePluginOptionsWithoutSchema extends PluginManifest {
  execute: PluginExecuteFn;
  hooks?: PluginHooks;
  resultSchema?: z.ZodType;
}

export type CreatePluginOptions<T extends z.ZodType = z.ZodType> =
  | CreatePluginOptionsWithSchema<T>
  | CreatePluginOptionsWithoutSchema;

function wrapWithCancellation<TConfig>(
  execute: (config: TConfig, context: PluginContext) => Promise<PluginResult>,
): (config: TConfig, context: PluginContext) => Promise<PluginResult> {
  return async (config, context) => {
    try {
      return await execute(config, context);
    } catch (error) {
      if (error instanceof PluginCancelledError) {
        return {
          success: false,
          code: PluginFailureCodes.PLUGIN_CANCELLED,
          message: error.message,
        };
      }
      throw error;
    }
  };
}

function wrapWithHooks<TConfig>(
  execute: (config: TConfig, context: PluginContext) => Promise<PluginResult>,
  hooks: PluginHooks<TConfig> | undefined,
): (config: TConfig, context: PluginContext) => Promise<PluginResult> {
  const cancellableExecute = wrapWithCancellation(execute);

  if (!hooks) {
    return cancellableExecute;
  }

  return async (config, context) => {
    try {
      await hooks.beforeExecute?.(config, context);
      const result = await cancellableExecute(config, context);
      await hooks.afterExecute?.(result, config, context);
      return result;
    } catch (error) {
      if (error instanceof PluginCancelledError) {
        return {
          success: false,
          code: PluginFailureCodes.PLUGIN_CANCELLED,
          message: error.message,
        };
      }
      const err = error instanceof Error ? error : new Error(String(error));
      await hooks.onError?.(err, config, context);
      return { success: false, message: err.message };
    }
  };
}

export function createPlugin<T extends z.ZodType>(
  options: CreatePluginOptionsWithSchema<T>,
): PluginDefinition;
export function createPlugin(options: CreatePluginOptionsWithoutSchema): PluginDefinition;
export function createPlugin<T extends z.ZodType>(
  options: CreatePluginOptionsWithSchema<T> | CreatePluginOptionsWithoutSchema,
): PluginDefinition {
  const { name, version, description, execute, hooks, resultSchema } = options;

  if ('configSchema' in options && options.configSchema) {
    const { configSchema } = options;
    const typedExecute = execute as (
      config: z.infer<T>,
      context: PluginContext,
    ) => Promise<PluginResult>;
    const wrappedExecute = wrapWithHooks(
      typedExecute,
      hooks as PluginHooks<z.infer<T>> | undefined,
    );

    return {
      name,
      version,
      description,
      hooks,
      configSchema,
      resultSchema,
      execute: async (rawConfig, context) => {
        const parsed = configSchema.safeParse(rawConfig);
        if (!parsed.success) {
          return {
            success: false,
            code: PluginFailureCodes.PLUGIN_CONFIG_INVALID,
            message: formatZodError(parsed.error),
          };
        }
        return wrappedExecute(parsed.data, context);
      },
    };
  }

  const legacyExecute = execute as PluginExecuteFn;

  return {
    name,
    version,
    description,
    hooks,
    resultSchema,
    execute: wrapWithHooks(legacyExecute, hooks),
  };
}

/**
 * 获取插件配置值的辅助函数
 */
export function getConfig<T = unknown>(config: PluginConfig, key: string): T | undefined {
  return config[key] as T | undefined;
}

/**
 * 获取上下文值的辅助函数
 */
export function getContext<T = unknown>(context: PluginContext, key: string): T | undefined {
  return context[key] as T | undefined;
}
