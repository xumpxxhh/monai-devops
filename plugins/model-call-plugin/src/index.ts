import {
  createPlugin,
  getAbortSignal,
  getLogger,
  PluginCancelledError,
  throwIfAborted,
  z,
} from '@monai-devops/plugin-sdk';
import type { PluginContext, PluginResult } from '@monai-devops/plugin-sdk';
import { ChatOpenAI } from '@langchain/openai';

const configSchema = z.object({
  message: z.string().default('Hello from model-call-plugin'),
  apiKey: z.string().min(1, 'apiKey is required'),
});

/**
 * model-call-plugin 插件执行函数
 */
async function executeModelCallPlugin(
  config: z.infer<typeof configSchema>,
  context: PluginContext,
): Promise<PluginResult> {
  const log = getLogger(context);
  const signal = getAbortSignal(context);
  const { message, apiKey } = config;

  const openAIModel = new ChatOpenAI({
    configuration: {
      baseURL: 'https://api.deepseek.com',
      apiKey,
    },
    model: 'deepseek-v4-flash',
  });

  log.info('开始执行插件', { plugin: 'model-call-plugin', message });

  try {
    throwIfAborted(context);

    const response = await openAIModel.stream(message, { signal });

    let fullResponse = '';

    for await (const chunk of response) {
      throwIfAborted(context);
      log.append(chunk.content.toString(), 'stdout');
      fullResponse += chunk.content.toString();
    }

    return {
      success: true,
      message: `插件执行成功: ${message}`,
      data: fullResponse,
    };
  } catch (error) {
    if (error instanceof PluginCancelledError) {
      throw error;
    }
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
  description: '这是一个调用模型插件',
  configSchema,
  execute: executeModelCallPlugin,
  hooks: {
    beforeExecute: async () => {},
    afterExecute: async () => {},
    onError: async () => {},
  },
});

export default modelCallPlugin;
