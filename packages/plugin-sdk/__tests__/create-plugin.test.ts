import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPlugin, PluginFailureCodes, z, formatZodError } from '../index.js';

const configSchema = z.object({
  type: z.enum(['unit', 'integration', 'e2e']),
  label: z.string().default('default-label'),
});

describe('createPlugin with configSchema', () => {
  it('returns PLUGIN_CONFIG_INVALID when config fails validation', async () => {
    const plugin = createPlugin({
      name: 'typed-plugin',
      version: '1.0.0',
      configSchema,
      execute: async (config) => ({
        success: true,
        data: { type: config.type },
      }),
    });

    const result = await plugin.execute({ type: 'invalid' }, {});

    assert.equal(result.success, false);
    assert.equal(result.code, PluginFailureCodes.PLUGIN_CONFIG_INVALID);
    assert.match(result.message ?? '', /type/);
  });

  it('parses config and applies defaults before execute', async () => {
    const plugin = createPlugin({
      name: 'typed-plugin',
      version: '1.0.0',
      configSchema,
      execute: async (config) => ({
        success: true,
        data: { type: config.type, label: config.label },
      }),
    });

    const result = await plugin.execute({ type: 'unit' }, {});

    assert.equal(result.success, true);
    assert.deepEqual(result.data, { type: 'unit', label: 'default-label' });
  });

  it('exposes configSchema on PluginDefinition', () => {
    const plugin = createPlugin({
      name: 'typed-plugin',
      version: '1.0.0',
      configSchema,
      execute: async () => ({ success: true }),
    });

    assert.equal(plugin.configSchema, configSchema);
  });

  it('passes parsed config to hooks', async () => {
    let hookConfig: { type: string; label: string } | undefined;

    const plugin = createPlugin({
      name: 'typed-plugin',
      version: '1.0.0',
      configSchema,
      execute: async () => ({ success: true }),
      hooks: {
        beforeExecute: async (config) => {
          hookConfig = config;
        },
      },
    });

    await plugin.execute({ type: 'e2e', label: 'custom' }, {});

    assert.deepEqual(hookConfig, { type: 'e2e', label: 'custom' });
  });

  it('does not call execute when validation fails', async () => {
    let executed = false;

    const plugin = createPlugin({
      name: 'typed-plugin',
      version: '1.0.0',
      configSchema,
      execute: async () => {
        executed = true;
        return { success: true };
      },
    });

    await plugin.execute({}, {});

    assert.equal(executed, false);
  });
});

describe('createPlugin without configSchema', () => {
  it('accepts raw PluginConfig for backward compatibility', async () => {
    const plugin = createPlugin({
      name: 'legacy-plugin',
      version: '1.0.0',
      execute: async (config) => ({
        success: true,
        data: { type: config.type },
      }),
    });

    const result = await plugin.execute({ type: 'unit' }, {});

    assert.equal(result.success, true);
    assert.deepEqual(result.data, { type: 'unit' });
  });
});

describe('formatZodError', () => {
  it('formats field paths and messages', () => {
    const parsed = configSchema.safeParse({ type: 'bad' });
    assert.equal(parsed.success, false);
    if (!parsed.success) {
      const message = formatZodError(parsed.error);
      assert.match(message, /type:/);
    }
  });
});
