/**
 * 插件SDK入口文件
 * @module @monai-devops/plugin-sdk
 */

export * from "./types";
export * from "./base";
export * from "./hooks";

export type {
  PluginManifest,
  PluginConfig,
  PluginContext,
  PluginResult,
  PluginFailureCode,
} from "./types";

export { PluginFailureCodes } from "./types";

export {
  createPlugin,
  getConfig,
  getContext,
  type CreatePluginOptions,
  type PluginDefinition,
  type PluginExecuteFn,
} from "./base";
