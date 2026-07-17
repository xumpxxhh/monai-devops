import { zodToJsonSchema } from 'zod-to-json-schema';
import type { PluginDefinition } from '@monai-devops/plugin-sdk';

type ResultSchema = NonNullable<PluginDefinition['resultSchema']>;

/**
 * 将插件 Zod resultSchema 转为 JSON Schema，供前端选择注入字段。
 */
export function toPluginResultJsonSchema(schema: ResultSchema): Record<string, unknown> {
  return zodToJsonSchema(schema as never, {
    $refStrategy: 'none',
  }) as Record<string, unknown>;
}
