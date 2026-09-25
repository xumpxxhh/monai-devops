import type { PluginExecutionAdapter, PluginExecutor } from './types.js';

/** Trusted in-process bridge; plugin manager retains its existing error and cancellation semantics. */
export function createLocalPluginAdapter(executePlugin: PluginExecutor): PluginExecutionAdapter {
  return { kind: 'local', execute: executePlugin };
}
