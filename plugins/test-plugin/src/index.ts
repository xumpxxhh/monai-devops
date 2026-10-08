import {
  createPlugin,
  getContext,
  getLogger,
  PluginContextKeys,
  PluginFailureCodes,
  sleep,
  throwIfAborted,
  z,
} from '@monai-devops/plugin-sdk';
import type { PluginContext, PluginResult } from '@monai-devops/plugin-sdk';

const configSchema = z.object({
  type: z.enum(['unit', 'integration', 'e2e', 'wait', 'failure']),
});

/**
 * 测试插件执行函数
 */
async function executeTestPlugin(
  config: z.infer<typeof configSchema>,
  context: PluginContext,
): Promise<PluginResult> {
  const { type } = config;
  const log = getLogger(context);

  if (type === 'failure') {
    log.error('测试故障已触发');
    return {
      success: false,
      code: PluginFailureCodes.PLUGIN_EXECUTION_ERROR,
      message: '测试插件故障',
    };
  }

  if (type === 'wait') {
    const checkpoint = getContext(context, PluginContextKeys.checkpoint);
    if (!checkpoint) {
      log.info('测试等待已登记');
      return {
        success: true,
        wait: { checkpoint: { stage: 'approval' }, condition: { kind: 'signal', key: 'approved' } },
      };
    }
    log.info('测试等待已唤醒');
    return { success: true, data: { type, message: '等待已唤醒' } };
  }

  log.info('开始执行测试', { type });
  await sleep(3000, context);
  throwIfAborted(context);
  log.append('[runner] starting...\n', 'stdout');
  log.append('[runner] ' + type + '...\n', 'stdout');

  await sleep(3000, context);
  throwIfAborted(context);

  log.info('测试执行完成', { type });

  switch (type) {
    case 'unit':
      return {
        success: true,
        message: '单元测试执行成功',
        data: { type, message: '单元测试执行成功' },
      };
    case 'integration':
      return {
        success: true,
        message: '集成测试执行成功',
        data: { type, message: '集成测试执行成功' },
      };
    case 'e2e':
      return {
        success: true,
        message: 'E2E测试执行成功',
        data: { type, message: 'E2E测试执行成功' },
      };
  }
}

/**
 * 测试插件定义
 */
export const testPlugin = createPlugin({
  name: 'test-plugin',
  version: '1.0.0',
  capabilities: ['execution.wait'],
  description: '这是一个测试插件',
  configSchema,
  resultSchema: z.object({
    type: z.enum(['unit', 'integration', 'e2e', 'wait', 'failure']),
    message: z.string(),
  }),
  execute: executeTestPlugin,
  hooks: {
    beforeExecute: async () => {},
    afterExecute: async () => {},
    onError: async () => {},
  },
});

export default testPlugin;
