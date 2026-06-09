import { createPlugin, getConfig, getLogger } from '@monai-devops/plugin-sdk';
import type { PluginConfig, PluginContext, PluginResult } from '@monai-devops/plugin-sdk';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 测试插件执行函数
 */
async function executeTestPlugin(
  config: PluginConfig,
  context: PluginContext,
): Promise<PluginResult> {
  const type = getConfig<string>(config, 'type');
  const log = getLogger(context);

  log.info('开始执行测试', { type });
  await delay(3000);
  log.append('[runner] building...\n', 'stdout');

  await delay(3000);

  log.info('测试执行完成', { type });

  try {
    switch (type) {
      case 'unit':
        return {
          success: true,
          message: '单元测试执行成功',
        };
      case 'integration':
        return {
          success: true,
          message: '集成测试执行成功',
        };
      case 'e2e':
        return {
          success: true,
          message: 'E2E测试执行成功',
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
  name: 'test-plugin',
  version: '1.0.0',
  execute: executeTestPlugin,
  hooks: {
    beforeExecute: async () => {},
    afterExecute: async () => {},
    onError: async () => {},
  },
});

export default testPlugin;
