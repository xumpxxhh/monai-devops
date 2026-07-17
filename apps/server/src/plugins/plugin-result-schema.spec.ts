import { z } from '@monai-devops/plugin-sdk';
import { toPluginResultJsonSchema } from './plugin-result-schema.js';

const resultSchema = z.object({
  answer: z.string(),
  usage: z.object({ tokens: z.number() }),
});

describe('toPluginResultJsonSchema', () => {
  it('converts plugin resultSchema to JSON Schema object', () => {
    const jsonSchema = toPluginResultJsonSchema(resultSchema);

    expect(jsonSchema.type).toBe('object');
    const properties = jsonSchema.properties as Record<string, { type?: string }>;
    expect(properties.answer.type).toBe('string');
    expect(jsonSchema.required).toEqual(expect.arrayContaining(['answer', 'usage']));
  });

  it('inlines schema without $ref when using none strategy', () => {
    const jsonSchema = toPluginResultJsonSchema(resultSchema);

    expect(jsonSchema).not.toHaveProperty('$ref');
    expect(jsonSchema).not.toHaveProperty('$defs');
  });
});
