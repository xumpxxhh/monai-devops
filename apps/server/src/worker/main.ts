import '../preload-env.js';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { registeredPlugins } from '../plugins/plugin-registry.js';
import { WorkerClient } from './worker-client.js';

async function main(): Promise<void> {
  const allowed = new Set(
    (process.env.EXECUTOR_WORKER_ALLOWED_PLUGINS ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  );
  const plugins = registeredPlugins.filter((plugin) => allowed.has(plugin.name));
  const secretNames = (process.env.EXECUTOR_WORKER_SECRET_NAMES ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (secretNames.some((name) => !/^[A-Z][A-Z0-9_]{0,127}$/.test(name))) {
    throw new Error('Invalid worker Secret environment allowlist');
  }
  const secretEnv = Object.fromEntries(
    secretNames
      .map((name) => [name, process.env[name]])
      .filter((entry) => typeof entry[1] === 'string'),
  ) as Record<string, string>;
  if (plugins.length === 0 || plugins.length !== allowed.size) {
    throw new Error('Worker allowlist must name only registered plugin entries');
  }
  const client = new WorkerClient({
    serverUrl: process.env.EXECUTOR_SERVER_URL ?? '',
    token: process.env.EXECUTOR_WORKER_HTTP_TOKEN ?? '',
    workerId: process.env.EXECUTOR_WORKER_ID ?? `${hostname()}-${process.pid}`,
    plugins,
    secretEnv,
    claimWaitMs: process.env.EXECUTOR_WORKER_CLAIM_WAIT_MS
      ? Number(process.env.EXECUTOR_WORKER_CLAIM_WAIT_MS)
      : undefined,
  });
  const stopping = new AbortController();
  process.once('SIGINT', () => stopping.abort());
  process.once('SIGTERM', () => stopping.abort());
  while (!stopping.signal.aborted) {
    try {
      await client.runOnce(stopping.signal);
    } catch (error) {
      if (stopping.signal.aborted) break;
      console.error(
        `Worker cycle failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      await delay(1_000, undefined, { signal: stopping.signal }).catch(() => undefined);
    }
  }
}

void main().catch((error: unknown) => {
  console.error(
    `Worker startup failed: ${error instanceof Error ? error.message : 'unknown error'}`,
  );
  process.exitCode = 1;
});
