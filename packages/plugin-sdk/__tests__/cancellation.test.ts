import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PluginCancelledError,
  PluginFailureCodes,
  PluginContextKeys,
  throwIfAborted,
  isAborted,
  sleep,
  createPlugin,
} from '../index.js';

describe('cooperative cancellation helpers', () => {
  it('isAborted returns false without signal', () => {
    assert.equal(isAborted({}), false);
  });

  it('throwIfAborted throws PluginCancelledError when signal aborted', () => {
    const controller = new AbortController();
    controller.abort();

    assert.throws(
      () => throwIfAborted({ [PluginContextKeys.signal]: controller.signal }),
      PluginCancelledError,
    );
  });

  it('sleep rejects with PluginCancelledError when aborted during wait', async () => {
    const controller = new AbortController();
    const context = { [PluginContextKeys.signal]: controller.signal };

    const pending = sleep(500, context);
    controller.abort();

    await assert.rejects(pending, PluginCancelledError);
  });

  it('createPlugin maps PluginCancelledError to PLUGIN_CANCELLED result', async () => {
    const plugin = createPlugin({
      name: 'cancel-plugin',
      version: '1.0.0',
      execute: async (_config, context) => {
        throwIfAborted(context);
        return { success: true };
      },
    });

    const controller = new AbortController();
    controller.abort();

    const result = await plugin.execute({}, { [PluginContextKeys.signal]: controller.signal });

    assert.equal(result.success, false);
    assert.equal(result.code, PluginFailureCodes.PLUGIN_CANCELLED);
  });
});
