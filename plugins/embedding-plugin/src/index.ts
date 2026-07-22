import {
  createPlugin,
  getLogger,
  PluginCancelledError,
  throwIfAborted,
  z,
} from '@monai-devops/plugin-sdk';
import type { PluginContext, PluginResult } from '@monai-devops/plugin-sdk';
import { OpenAIEmbeddings } from '@langchain/openai';
import { env } from 'node:process';

const DEFAULT_BASE_URL =
  'https://llm-5vs4jf61x3o1aul1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';

const configSchema = z
  .object({
    text: z.string().min(1).optional(),
    texts: z.array(z.string().min(1)).min(1).optional(),
    apiKey: z.string().min(1).optional(),
    model: z.string().default('text-embedding-v4'),
    baseURL: z.string().url().default(DEFAULT_BASE_URL),
    batchSize: z.number().int().positive().default(10),
  })
  .superRefine((data, ctx) => {
    const hasText = data.text !== undefined;
    const hasTexts = data.texts !== undefined;

    if (!hasText && !hasTexts) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '必须提供 text 或 texts 之一',
      });
    }

    if (hasText && hasTexts) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'text 与 texts 不能同时提供',
      });
    }
  });

const resultSchema = z.object({
  model: z.string(),
  dimensions: z.number(),
  count: z.number(),
  embedding: z.array(z.number()).optional(),
  embeddings: z.array(z.array(z.number())).optional(),
});

type EmbeddingConfig = z.infer<typeof configSchema>;

/**
 * embedding-plugin 插件执行函数
 */
async function executeEmbeddingPlugin(
  config: EmbeddingConfig,
  context: PluginContext,
): Promise<PluginResult> {
  const log = getLogger(context);
  const apiKey = config.apiKey ?? env.EMBEDDING_API_KEY;

  if (!apiKey) {
    return {
      success: false,
      message: '缺少 apiKey：请在插件配置中传入，或设置环境变量 EMBEDDING_API_KEY',
    };
  }

  const inputs = config.texts ?? (config.text !== undefined ? [config.text] : []);
  const isBatch = config.texts !== undefined;

  log.info('开始执行插件', {
    plugin: 'embedding-plugin',
    model: config.model,
    count: inputs.length,
    mode: isBatch ? 'batch' : 'single',
  });

  const embeddings = new OpenAIEmbeddings({
    model: config.model,
    batchSize: config.batchSize,
    apiKey,
    configuration: {
      baseURL: config.baseURL,
    },
  });

  try {
    throwIfAborted(context);

    if (isBatch) {
      log.info('批量生成 embedding', { count: inputs.length });
      const vectors = await embeddings.embedDocuments(inputs);

      throwIfAborted(context);

      const dimensions = vectors[0]?.length ?? 0;
      log.info('批量 embedding 完成', { count: vectors.length, dimensions });

      return {
        success: true,
        message: `成功生成 ${vectors.length} 条 embedding`,
        data: {
          model: config.model,
          dimensions,
          count: vectors.length,
          embeddings: vectors,
        },
      };
    }

    const text = inputs[0]!;
    log.info('生成单条 embedding', { textLength: text.length });

    const vector = await embeddings.embedQuery(text);

    throwIfAborted(context);

    log.info('单条 embedding 完成', { dimensions: vector.length });

    return {
      success: true,
      message: '成功生成 embedding',
      data: {
        model: config.model,
        dimensions: vector.length,
        count: 1,
        embedding: vector,
      },
    };
  } catch (error) {
    log.error('插件执行失败', { error: (error as Error).message });

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
 * embedding-plugin 插件定义
 */
export const embeddingPlugin = createPlugin({
  name: 'embedding-plugin',
  version: '1.0.0',
  description: '调用 Embedding 模型，将文本转换为向量',
  configSchema,
  resultSchema,
  execute: executeEmbeddingPlugin,
});

export default embeddingPlugin;
