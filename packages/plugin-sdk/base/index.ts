/**
 * 基础插件函数
 * @module base
 */

import type {
  PluginManifest,
  PluginConfig,
  PluginContext,
  PluginResult,
} from "../types/index.js";
import type { PluginHooks } from "../hooks/index.js";

/**
 * 插件执行函数类型
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
}

/**
 * createPlugin 入参
 */
export interface CreatePluginOptions extends PluginManifest {
  execute: PluginExecuteFn;
  hooks?: PluginHooks;
}

/**
 * 创建插件配置的辅助函数。
 * 传入 hooks 时，对外暴露的 execute 会自动编排 beforeExecute / afterExecute / onError。
 */
export function createPlugin({
  name,
  version,
  description,
  execute,
  hooks,
}: CreatePluginOptions): PluginDefinition {
  return {
    name,
    version,
    description,
    hooks,
    execute: hooks
      ? async (config, context) => {
          try {
            await hooks.beforeExecute?.(config, context);
            const result = await execute(config, context);
            await hooks.afterExecute?.(result, config, context);
            return result;
          } catch (error) {
            const err =
              error instanceof Error ? error : new Error(String(error));
            await hooks.onError?.(err, config, context);
            return { success: false, message: err.message };
          }
        }
      : execute,
  };
}

/**
 * 获取插件配置值的辅助函数
 */
export function getConfig<T = unknown>(
  config: PluginConfig,
  key: string,
): T | undefined {
  return config[key] as T | undefined;
}

/**
 * 获取上下文值的辅助函数
 */
export function getContext<T = unknown>(
  context: PluginContext,
  key: string,
): T | undefined {
  return context[key] as T | undefined;
}
