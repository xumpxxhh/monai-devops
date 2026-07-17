import { createPlugin, getLogger, z } from '@monai-devops/plugin-sdk';
import type { PluginContext, PluginResult } from '@monai-devops/plugin-sdk';

const configSchema = z.object({
  data: z.any(),
});

/** 安全序列化：处理循环引用、BigInt、Error、函数等不可 JSON 化的值 */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    const result = JSON.stringify(
      value,
      (_key, val: unknown) => {
        if (typeof val === 'bigint') return val.toString();
        if (typeof val === 'function') {
          return `[Function: ${(val as { name?: string }).name || 'anonymous'}]`;
        }
        if (typeof val === 'symbol') return val.toString();
        if (val instanceof Error) {
          return { name: val.name, message: val.message, stack: val.stack };
        }
        if (val !== null && typeof val === 'object') {
          if (seen.has(val)) return '[Circular]';
          seen.add(val);
        }
        return val;
      },
      2,
    );
    return result ?? String(value);
  } catch (error) {
    return `[Unserializable: ${(error as Error).message}]`;
  }
}

/**
 * print-plugin 插件执行函数
 */
async function executePrintPlugin(
  config: z.infer<typeof configSchema>,
  context: PluginContext,
): Promise<PluginResult> {
  const log = getLogger(context);
  const { data } = config;

  log.info('开始执行插件', { plugin: 'print-plugin' });

  const message = safeStringify(data);
  log.append(message, 'stdout');

  try {
    return {
      success: true,
      message: `插件执行成功: ${message}`,
      data: { message },
    };
  } catch (error) {
    return {
      success: false,
      message: `插件执行失败: ${(error as Error).message}`,
    };
  }
}

/**
 * print-plugin 插件定义
 */
export const printPlugin = createPlugin({
  name: 'print-plugin',
  version: '1.0.0',
  configSchema,
  resultSchema: z.object({
    message: z.string(),
  }),
  execute: executePrintPlugin,
  description: '向日志打印信息插件',
  hooks: {
    beforeExecute: async () => {},
    afterExecute: async () => {},
    onError: async () => {},
  },
});

export default printPlugin;
