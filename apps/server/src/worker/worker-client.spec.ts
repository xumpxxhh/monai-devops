import { jest } from '@jest/globals';
import { setTimeout as delay } from 'node:timers/promises';
import { EXECUTOR_PROTOCOL_VERSION, type ExecutorDispatchV1 } from '@monai-devops/core-engine';
import { PluginContextKeys } from '@monai-devops/plugin-sdk';
import type { PluginDefinition } from '@monai-devops/plugin-sdk';
import { WorkerClient } from './worker-client.js';

const token = 'test-worker-token-with-at-least-32-characters';
const execution = { jobId: 'run-1/step', attemptId: 'run-1/step/attempt-0', attempt: 0 };
const dispatch: ExecutorDispatchV1 = {
  protocolVersion: EXECUTOR_PROTOCOL_VERSION,
  runId: 'run-1',
  workflowId: 'workflow-1',
  stepId: 'step',
  execution,
  plugin: { name: 'safe-plugin', version: '1.0.0' },
  idempotencyKey: execution.jobId,
  policyVersion: 'test-policy',
  requiredCapabilities: [],
  input: { config: { value: 7 }, context: {} },
};

function assignment(request = dispatch) {
  return {
    dispatch: request,
    claim: {
      protocolVersion: EXECUTOR_PROTOCOL_VERSION,
      execution,
      workerId: 'worker-1',
      leaseToken: 'lease-token',
      leaseExpiresAt: new Date(Date.now() + 3_000).toISOString(),
      nextSequence: 1,
    },
  };
}

function json(value: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(JSON.stringify(value)) as unknown,
  } as Response;
}

describe('WorkerClient', () => {
  it('claims and completes an allowlisted plugin without database access', async () => {
    const messages: Array<Record<string, unknown>> = [];
    const plugin: PluginDefinition = {
      name: 'safe-plugin',
      version: '1.0.0',
      execute: jest.fn(async (config) => ({ success: true, data: config })),
    };
    const fetchImpl = jest.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${token}` });
      if (String(url).endsWith('/claim')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          plugins: [{ name: 'safe-plugin', version: '1.0.0', capabilities: [] }],
        });
        return json({ assignment: assignment() });
      }
      const message = JSON.parse(String(init?.body)) as Record<string, unknown>;
      messages.push(message);
      return json({ accepted: true });
    });
    const client = new WorkerClient({
      serverUrl: 'http://localhost:3000/api/v1/devops',
      token,
      workerId: 'worker-1',
      plugins: [plugin],
      claimWaitMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await client.runOnce()).toBe(true);
    expect(plugin.execute).toHaveBeenCalledWith({ value: 7 }, expect.objectContaining({}));
    expect(messages).toMatchObject([
      { kind: 'complete', sequence: 1, result: { success: true, data: { value: 7 } } },
    ]);
  });

  it('sends ordered heartbeats while a plugin is still running', async () => {
    const messages: Array<Record<string, unknown>> = [];
    const plugin: PluginDefinition = {
      name: 'safe-plugin',
      version: '1.0.0',
      execute: async () => {
        await delay(1_100);
        return { success: true };
      },
    };
    const fetchImpl = jest.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      if (String(url).endsWith('/claim')) return json({ assignment: assignment() });
      messages.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({ accepted: true });
    });
    const client = new WorkerClient({
      serverUrl: 'http://localhost:3000/api/v1/devops',
      token,
      workerId: 'worker-1',
      plugins: [plugin],
      claimWaitMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.runOnce();
    expect(messages.map(({ kind, sequence }) => [kind, sequence])).toEqual([
      ['heartbeat', 1],
      ['complete', 2],
    ]);
  });

  it('settles unsupported capabilities as a failure without invoking the plugin', async () => {
    const plugin: PluginDefinition = {
      name: 'safe-plugin',
      version: '1.0.0',
      execute: jest.fn(async () => ({ success: true })),
    };
    let completion: Record<string, unknown> | undefined;
    const fetchImpl = jest.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      if (String(url).endsWith('/claim')) {
        return json({ assignment: assignment({ ...dispatch, requiredCapabilities: ['network'] }) });
      }
      completion = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({ accepted: true });
    });
    const client = new WorkerClient({
      serverUrl: 'http://localhost:3000/api/v1/devops',
      token,
      workerId: 'worker-1',
      plugins: [plugin],
      claimWaitMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.runOnce();
    expect(plugin.execute).not.toHaveBeenCalled();
    expect(completion).toMatchObject({ kind: 'complete', result: { success: false } });
  });

  it('retries an uncertain completion with the same sequence', async () => {
    const messages: Array<Record<string, unknown>> = [];
    const plugin: PluginDefinition = {
      name: 'safe-plugin',
      version: '1.0.0',
      execute: async () => ({ success: true }),
    };
    const fetchImpl = jest.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      if (String(url).endsWith('/claim')) return json({ assignment: assignment() });
      messages.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (messages.length === 1) throw new Error('response lost');
      return json({ accepted: false, code: 'duplicate' });
    });
    const client = new WorkerClient({
      serverUrl: 'http://localhost:3000/api/v1/devops',
      token,
      workerId: 'worker-1',
      plugins: [plugin],
      claimWaitMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.runOnce();
    expect(messages.map(({ kind, sequence }) => [kind, sequence])).toEqual([
      ['complete', 1],
      ['complete', 1],
    ]);
  });

  it('refuses plaintext HTTP for non-local hosts', () => {
    expect(
      () =>
        new WorkerClient({
          serverUrl: 'http://example.com/api/v1/devops',
          token,
          workerId: 'worker-1',
          plugins: [],
        }),
    ).toThrow('requires HTTPS');
  });

  it('aborts plugin execution at the server-issued deadline', async () => {
    let observedAbort = false;
    const plugin: PluginDefinition = {
      name: 'safe-plugin',
      version: '1.0.0',
      execute: async (_config, context) => {
        const signal = context[PluginContextKeys.signal] as AbortSignal;
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        observedAbort = signal.aborted;
        return { success: false };
      },
    };
    const fetchImpl = jest.fn(async (url: URL | RequestInfo) => {
      if (String(url).endsWith('/claim')) {
        return json({
          assignment: assignment({
            ...dispatch,
            deadlineAt: new Date(Date.now() + 50).toISOString(),
          }),
        });
      }
      throw new Error('Expired attempt must not report completion');
    });
    const client = new WorkerClient({
      serverUrl: 'http://localhost:3000/api/v1/devops',
      token,
      workerId: 'worker-1',
      plugins: [plugin],
      claimWaitMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.runOnce()).rejects.toThrow('Worker execution aborted');
    expect(observedAbort).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
