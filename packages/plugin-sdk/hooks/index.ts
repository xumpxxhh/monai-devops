/**
 * 生命周期钩子
 * @module hooks
 */

import type { PluginConfig, PluginContext, PluginResult } from '../types/index.js';

/**
 * 插件生命周期钩子。
 *
 * 由 {@link createPlugin} 绑定到对外暴露的 `execute` 上编排执行。
 *
 * 错误语义：
 * - `execute` / `beforeExecute` 抛异常 → 调用 `onError` → 返回 `{ success: false, message }`
 * - `execute` 返回 `{ success: false }` → 业务失败，仍调用 `afterExecute`，不调用 `onError`
 */
export interface PluginHooks {
  beforeExecute?: (config: PluginConfig, context: PluginContext) => Promise<void> | void;
  afterExecute?: (
    result: PluginResult,
    config: PluginConfig,
    context: PluginContext,
  ) => Promise<void> | void;
  onError?: (error: Error, config: PluginConfig, context: PluginContext) => Promise<void> | void;
}
