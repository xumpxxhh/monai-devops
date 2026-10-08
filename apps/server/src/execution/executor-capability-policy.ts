import type { PluginManifest } from '@monai-devops/plugin-sdk';
import type { PluginStep } from '@monai-devops/core-engine';

export class ExecutorCapabilityDeniedError extends Error {
  readonly code = 'EXECUTOR_CAPABILITY_DENIED';

  constructor(
    readonly capability: string,
    readonly boundary: 'plugin' | 'environment',
  ) {
    super(`EXECUTOR_CAPABILITY_DENIED: ${capability} (${boundary})`);
    this.name = 'ExecutorCapabilityDeniedError';
  }
}

/** Remote authority is the intersection of plugin declaration, workflow request and host policy. */
export function authorizeExecutorCapabilities(
  plugin: PluginManifest,
  step: PluginStep,
  environmentAllowlist: string,
): string[] {
  const required = new Set<string>();
  if (step.mayWait) required.add('execution.wait');
  for (const capability of step.requestedCapabilities ?? []) required.add(capability);
  const declared = new Set(plugin.capabilities ?? []);
  const allowed = new Set(
    environmentAllowlist
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  for (const capability of [...required].sort()) {
    if (!declared.has(capability)) {
      throw new ExecutorCapabilityDeniedError(capability, 'plugin');
    }
    if (!allowed.has(capability)) {
      throw new ExecutorCapabilityDeniedError(capability, 'environment');
    }
  }
  return [...required].sort();
}
