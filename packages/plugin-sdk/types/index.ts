/**
 * 插件类型定义
 * @module types
 */

import type { z } from 'zod';
/**
 * 插件注册元数据
 */
export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
}

/**
 * 引擎/工作流边界：来自 JSON 的原始 config
 */
export type PluginConfig = Record<string, unknown>;

/**
 * 由插件 configSchema 推断出的强类型 config
 */
export type InferPluginConfig<T extends z.ZodType> = z.infer<T>;

/**
 * 单次 execute 运行时上下文（编排器可注入任意扩展字段）
 */
export interface PluginContext {
  [key: string]: unknown;
}

/**
 * 插件失败错误码（仅 success: false 时使用）
 */
export const PluginFailureCodes = {
  PLUGIN_NOT_FOUND: 'PLUGIN_NOT_FOUND',
  PLUGIN_CONFIG_INVALID: 'PLUGIN_CONFIG_INVALID',
  PLUGIN_EXECUTION_ERROR: 'PLUGIN_EXECUTION_ERROR',
  PLUGIN_CANCELLED: 'PLUGIN_CANCELLED',
} as const;

/**
 * 插件协作取消时抛出；由 createPlugin / plugin manager 转为 PLUGIN_CANCELLED Result
 */
export class PluginCancelledError extends Error {
  readonly name = 'PluginCancelledError';

  constructor(message = '插件执行已取消') {
    super(message);
  }
}

export type PluginFailureCode = (typeof PluginFailureCodes)[keyof typeof PluginFailureCodes];

export interface PluginResult {
  success: boolean;
  message?: string;
  data?: unknown;
  code?: PluginFailureCode;
}
