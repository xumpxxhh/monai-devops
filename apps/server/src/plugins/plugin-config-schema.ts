import { zodToJsonSchema } from 'zod-to-json-schema';
import type { PluginDefinition } from '@monai-devops/plugin-sdk';

type ConfigSchema = NonNullable<PluginDefinition['configSchema']>;

/**
 * 将插件 Zod configSchema 转为 JSON Schema，供前端表单渲染。
 */
export function toPluginConfigJsonSchema(schema: ConfigSchema): Record<string, unknown> {
  return zodToJsonSchema(schema as never, {
    $refStrategy: 'none',
  }) as Record<string, unknown>;
}
