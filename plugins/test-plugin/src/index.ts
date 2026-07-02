import { createPlugin, getLogger, z } from '@monai-devops/plugin-sdk';
import type { PluginContext, PluginResult } from '@monai-devops/plugin-sdk';

const configSchema = z.object({
  type: z.enum(['unit', 'integration', 'e2e']),
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 测试插件执行函数
 */
async function executeTestPlugin(
  config: z.infer<typeof configSchema>,
  context: PluginContext,
): Promise<PluginResult> {
  const { type } = config;
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
  description: '这是一个测试插件',
  configSchema,
  execute: executeTestPlugin,
  hooks: {
    beforeExecute: async () => {},
    afterExecute: async () => {},
    onError: async () => {},
  },
});

export default testPlugin;
