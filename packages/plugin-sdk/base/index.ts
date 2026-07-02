/**
 * 基础插件函数
 * @module base
 */

import type { z } from 'zod';
import type { PluginManifest, PluginConfig, PluginContext, PluginResult } from '../types/index.js';
import { PluginFailureCodes } from '../types/index.js';
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
}

/**
 * createPlugin 入参（带 configSchema）
 */
export interface CreatePluginOptionsWithSchema<T extends z.ZodType> extends PluginManifest {
  configSchema: T;
  execute: (config: z.infer<T>, context: PluginContext) => Promise<PluginResult>;
  hooks?: PluginHooks<z.infer<T>>;
}

/**
 * createPlugin 入参（无 configSchema，向后兼容）
 */
export interface CreatePluginOptionsWithoutSchema extends PluginManifest {
  execute: PluginExecuteFn;
  hooks?: PluginHooks;
}

export type CreatePluginOptions<T extends z.ZodType = z.ZodType> =
  | CreatePluginOptionsWithSchema<T>
  | CreatePluginOptionsWithoutSchema;

function wrapWithHooks<TConfig>(
  execute: (config: TConfig, context: PluginContext) => Promise<PluginResult>,
  hooks: PluginHooks<TConfig> | undefined,
): (config: TConfig, context: PluginContext) => Promise<PluginResult> {
  if (!hooks) {
    return execute;
  }

  return async (config, context) => {
    try {
      await hooks.beforeExecute?.(config, context);
      const result = await execute(config, context);
      await hooks.afterExecute?.(result, config, context);
      return result;
    } catch (error) {
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
  const { name, version, description, execute, hooks } = options;

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
