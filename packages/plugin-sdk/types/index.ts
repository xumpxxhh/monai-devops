/**
 * 插件类型定义
 * @module types
 */

/**
 * 插件注册元数据
 */
export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
}

/**
 * 单次 execute 入参
 */
export interface PluginConfig {
  [key: string]: unknown;
}

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
  PLUGIN_NOT_FOUND: "PLUGIN_NOT_FOUND",
  PLUGIN_EXECUTION_ERROR: "PLUGIN_EXECUTION_ERROR",
} as const;

export type PluginFailureCode =
  (typeof PluginFailureCodes)[keyof typeof PluginFailureCodes];

export interface PluginResult {
  success: boolean;
  message?: string;
  data?: unknown;
  code?: PluginFailureCode;
}
