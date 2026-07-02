import { z } from '@monai-devops/plugin-sdk';
import { toPluginConfigJsonSchema } from './plugin-config-schema.js';

const configSchema = z.object({
  type: z.enum(['unit', 'integration', 'e2e']),
});

describe('toPluginConfigJsonSchema', () => {
  it('converts plugin configSchema to JSON Schema object', () => {
    const jsonSchema = toPluginConfigJsonSchema(configSchema);

    expect(jsonSchema.type).toBe('object');
    const properties = jsonSchema.properties as Record<string, { enum?: string[] }>;
    expect(properties.type.enum).toEqual(['unit', 'integration', 'e2e']);
    expect(jsonSchema.required).toEqual(['type']);
  });

  it('inlines schema without $ref when using none strategy', () => {
    const jsonSchema = toPluginConfigJsonSchema(configSchema);

    expect(jsonSchema).not.toHaveProperty('$ref');
    expect(jsonSchema).not.toHaveProperty('$defs');
  });
});
