import { createPlugin, getConfig, getLogger } from '@monai-devops/plugin-sdk';
import type { PluginConfig, PluginContext, PluginResult } from '@monai-devops/plugin-sdk';
import { ChatOpenAI } from '@langchain/openai';

export const openAIModel = new ChatOpenAI({
  configuration: {
    baseURL: 'https://api.deepseek.com',
  },
  model: 'deepseek-v4-flash',
});

/**
 * model-call-plugin 插件执行函数
 */
async function executeModelCallPlugin(
  config: PluginConfig,
  context: PluginContext,
): Promise<PluginResult> {
  const log = getLogger(context);
  const message = getConfig<string>(config, 'message') ?? 'Hello from model-call-plugin';

  log.info('开始执行插件', { plugin: 'model-call-plugin', message });

  try {
    const response = await openAIModel.stream(message);

    for await (const chunk of response) {
      log.append(chunk.content.toString(), 'stdout');
    }

    return {
      success: true,
      message: `插件执行成功: ${message}`,
    };
  } catch (error) {
    return {
      success: false,
      message: `插件执行失败: ${(error as Error).message}`,
    };
  }
}

/**
 * model-call-plugin 插件定义
 */
export const modelCallPlugin = createPlugin({
  name: 'model-call-plugin',
  version: '1.0.0',
  execute: executeModelCallPlugin,
  hooks: {
    beforeExecute: async () => {},
    afterExecute: async () => {},
    onError: async () => {},
  },
});

export default modelCallPlugin;
