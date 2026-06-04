import { createPlugin, getConfig } from "@monai-devops/plugin-sdk";
import type { PluginConfig, PluginContext, PluginResult } from "@monai-devops/plugin-sdk";

/**
 * 测试插件执行函数
 */
async function executeTestPlugin(
  config: PluginConfig,
  context: PluginContext,
): Promise<PluginResult> {
  const type = getConfig<string>(config, "type");

  try {
    switch (type) {
      case "unit":
        return {
          success: true,
          message: "单元测试执行成功",
        };
      case "integration":
        return {
          success: true,
          message: "集成测试执行成功",
        };
      case "e2e":
        return {
          success: true,
          message: "E2E测试执行成功",
        };
      default:
        return {
          success: false,
          message: `未知的测试类型: ${type}`,
        };
    }
  } catch (error) {
    return {
      success: false,
      message: `测试执行失败: ${(error as Error).message}`,
    };
  }
}

/**
 * 测试插件定义
 */
export const testPlugin = createPlugin({
  name: "test-plugin",
  version: "1.0.0",
  execute: executeTestPlugin,
  hooks: {
    beforeExecute: async (config, context) => {
      console.log("beforeExecute", config, context);
    },
    afterExecute: async (result, config, context) => {
      console.log("afterExecute", result, config, context);
    },
    onError: async (error, config, context) => {
      console.log("onError", error, config, context);
    },
  },
});

export default testPlugin;
