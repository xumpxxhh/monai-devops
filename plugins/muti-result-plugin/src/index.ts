import { createPlugin, getLogger, z } from '@monai-devops/plugin-sdk';
import type { PluginContext, PluginResult } from '@monai-devops/plugin-sdk';

const configSchema = z.object({
  message: z.string().default('Hello from muti-result-plugin'),
});

/** L5 → L1 共 5 层嵌套，含对象 / 数组 / 联合 / 可选字段 */
const resultSchema = z.object({
  // L1
  runId: z.string(),
  status: z.enum(['pending', 'running', 'succeeded', 'failed']),
  summary: z.object({
    // L2
    title: z.string(),
    score: z.number().min(0).max(100),
    tags: z.array(z.string()),
    metrics: z.object({
      // L3
      durationMs: z.number().int().nonnegative(),
      throughput: z.number(),
      errors: z.array(
        z.object({
          // L4
          code: z.string(),
          severity: z.enum(['info', 'warn', 'error', 'fatal']),
          detail: z.object({
            // L5
            message: z.string(),
            stack: z.string().optional(),
            context: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
            location: z.object({
              file: z.string(),
              line: z.number().int().positive(),
              column: z.number().int().nonnegative().optional(),
            }),
          }),
          related: z
            .array(
              z.object({
                // L5 (via related)
                refId: z.string(),
                kind: z.enum(['span', 'log', 'artifact']),
                payload: z.object({
                  uri: z.string().url().optional(),
                  bytes: z.number().int().nonnegative().optional(),
                  preview: z.string().nullable(),
                }),
              }),
            )
            .optional(),
        }),
      ),
      breakdown: z.object({
        // L4
        stages: z.array(
          z.object({
            name: z.string(),
            startedAt: z.string().datetime(),
            endedAt: z.string().datetime().optional(),
            result: z.discriminatedUnion('ok', [
              z.object({
                ok: z.literal(true),
                value: z.object({
                  // L5
                  output: z.string(),
                  artifacts: z.array(
                    z.object({
                      name: z.string(),
                      mime: z.string(),
                      size: z.number().int().nonnegative(),
                    }),
                  ),
                }),
              }),
              z.object({
                ok: z.literal(false),
                reason: z.object({
                  // L5
                  code: z.string(),
                  retryable: z.boolean(),
                  hints: z.array(z.string()),
                }),
              }),
            ]),
          }),
        ),
        totals: z.object({
          // L4
          success: z.number().int().nonnegative(),
          failed: z.number().int().nonnegative(),
          skipped: z.number().int().nonnegative(),
          nested: z.object({
            // L5
            deepestFlag: z.boolean(),
            notes: z.array(z.string()).default([]),
          }),
        }),
      }),
    }),
  }),
  payload: z.object({
    // L2
    version: z.string(),
    items: z.array(
      z.object({
        // L3
        id: z.string(),
        label: z.string(),
        meta: z.object({
          // L4
          owner: z.string(),
          priority: z.number().int().min(1).max(5),
          attrs: z.object({
            // L5
            region: z.string(),
            env: z.enum(['dev', 'staging', 'prod']),
            flags: z.record(z.string(), z.boolean()),
          }),
        }),
      }),
    ),
  }),
});

type MutiResultData = z.infer<typeof resultSchema>;

/**
 * muti-result-plugin 插件执行函数
 */
async function executeMutiResultPlugin(
  config: z.infer<typeof configSchema>,
  context: PluginContext,
): Promise<PluginResult> {
  const log = getLogger(context);
  const { message } = config;

  log.info('开始执行插件', { plugin: 'muti-result-plugin', message });

  try {
    const now = new Date().toISOString();
    const data: MutiResultData = {
      runId: `run-${Date.now()}`,
      status: 'succeeded',
      summary: {
        title: message,
        score: 92.5,
        tags: ['demo', 'nested', 'muti-result'],
        metrics: {
          durationMs: 1280,
          throughput: 42.7,
          errors: [
            {
              code: 'E_SAMPLE',
              severity: 'warn',
              detail: {
                message: '示例告警，不影响成功',
                stack: undefined,
                context: { attempt: 1, retry: false },
                location: { file: 'muti-result-plugin/src/index.ts', line: 1, column: 0 },
              },
              related: [
                {
                  refId: 'span-1',
                  kind: 'span',
                  payload: {
                    uri: 'https://example.com/trace/span-1',
                    bytes: 256,
                    preview: null,
                  },
                },
              ],
            },
          ],
          breakdown: {
            stages: [
              {
                name: 'prepare',
                startedAt: now,
                endedAt: now,
                result: {
                  ok: true,
                  value: {
                    output: `prepared: ${message}`,
                    artifacts: [{ name: 'manifest.json', mime: 'application/json', size: 128 }],
                  },
                },
              },
              {
                name: 'execute',
                startedAt: now,
                endedAt: now,
                result: {
                  ok: false,
                  reason: {
                    code: 'SOFT_FAIL',
                    retryable: true,
                    hints: ['降低并发', '检查下游超时'],
                  },
                },
              },
            ],
            totals: {
              success: 1,
              failed: 1,
              skipped: 0,
              nested: { deepestFlag: true, notes: ['L5 nested sample'] },
            },
          },
        },
      },
      payload: {
        version: '1.0.0',
        items: [
          {
            id: 'item-1',
            label: message,
            meta: {
              owner: 'muti-result-plugin',
              priority: 3,
              attrs: {
                region: 'cn-east',
                env: 'dev',
                flags: { verbose: true, dryRun: false },
              },
            },
          },
        ],
      },
    };

    return {
      success: true,
      message: `插件执行成功: ${message}`,
      data,
    };
  } catch (error) {
    return {
      success: false,
      message: `插件执行失败: ${(error as Error).message}`,
    };
  }
}

/**
 * muti-result-plugin 插件定义
 */
export const mutiResultPlugin = createPlugin({
  name: 'muti-result-plugin',
  version: '1.0.0',
  configSchema,
  resultSchema,
  description: '生成多层嵌套的结果插件',
  execute: executeMutiResultPlugin,
  hooks: {
    beforeExecute: async () => {},
    afterExecute: async () => {},
    onError: async () => {},
  },
});

export default mutiResultPlugin;
