import { setTimeout as delay } from 'node:timers/promises';
import {
  EXECUTOR_PROTOCOL_VERSION,
  validateExecutorDispatch,
  type ExecutorDispatchV1,
  type ExecutorLeaseClaimV1,
  type ExecutorMessageV1,
} from '@monai-devops/core-engine';
import {
  PluginContextKeys,
  PluginFailureCodes,
  type PluginDefinition,
  type PluginResult,
} from '@monai-devops/plugin-sdk';

interface Assignment {
  dispatch: ExecutorDispatchV1;
  claim: ExecutorLeaseClaimV1;
}

export interface WorkerClientOptions {
  serverUrl: string;
  token: string;
  workerId: string;
  plugins: PluginDefinition[];
  claimWaitMs?: number;
  fetchImpl?: typeof fetch;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class WorkerClient {
  private readonly baseUrl: URL;
  private readonly token: string;
  private readonly workerId: string;
  private readonly plugins: Map<string, PluginDefinition>;
  private readonly claimWaitMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: WorkerClientOptions) {
    this.baseUrl = new URL(`${options.serverUrl.replace(/\/$/, '')}/`);
    if (
      this.baseUrl.protocol !== 'https:' &&
      !(
        this.baseUrl.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(this.baseUrl.hostname)
      )
    ) {
      throw new Error('Worker transport requires HTTPS outside localhost');
    }
    if (options.token.trim().length < 32 || !options.workerId.trim()) {
      throw new Error('Worker token and identity are required');
    }
    this.token = options.token.trim();
    this.workerId = options.workerId.trim();
    this.plugins = new Map(options.plugins.map((plugin) => [plugin.name, plugin]));
    this.claimWaitMs = options.claimWaitMs ?? 20_000;
    if (!Number.isInteger(this.claimWaitMs) || this.claimWaitMs < 0 || this.claimWaitMs > 20_000) {
      throw new Error('Invalid worker claim wait');
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(path.endsWith('/claim') ? 25_000 : 10_000)])
      : AbortSignal.timeout(path.endsWith('/claim') ? 25_000 : 10_000);
    const response = await this.fetchImpl(new URL(path, this.baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: requestSignal,
    });
    if (!response.ok) throw new Error(`Worker transport ${path} failed: HTTP ${response.status}`);
    return response.json();
  }

  private parseAssignment(value: unknown): Assignment | undefined {
    if (!record(value)) throw new Error('Invalid worker claim response');
    if (value.assignment === null) return undefined;
    if (!record(value.assignment) || !record(value.assignment.claim)) {
      throw new Error('Invalid worker assignment');
    }
    const assignment = value.assignment as unknown as Assignment;
    validateExecutorDispatch(assignment.dispatch);
    const claim = assignment.claim;
    if (
      claim.protocolVersion !== EXECUTOR_PROTOCOL_VERSION ||
      claim.workerId !== this.workerId ||
      !record(claim.execution) ||
      claim.execution.jobId !== assignment.dispatch.execution.jobId ||
      claim.execution.attemptId !== assignment.dispatch.execution.attemptId ||
      claim.execution.attempt !== assignment.dispatch.execution.attempt ||
      !claim.leaseToken ||
      !Number.isInteger(claim.nextSequence) ||
      claim.nextSequence < 1 ||
      !Number.isFinite(Date.parse(claim.leaseExpiresAt)) ||
      Date.parse(claim.leaseExpiresAt) <= Date.now()
    ) {
      throw new Error('Invalid worker lease claim');
    }
    return assignment;
  }

  async runOnce(signal?: AbortSignal): Promise<boolean> {
    const response = await this.post(
      'executor-workers/claim',
      { workerId: this.workerId, waitMs: this.claimWaitMs },
      signal,
    );
    const assignment = this.parseAssignment(response);
    if (!assignment) return false;
    await this.execute(assignment, signal);
    return true;
  }

  private async execute(assignment: Assignment, stopSignal?: AbortSignal): Promise<void> {
    const { dispatch, claim } = assignment;
    const controller = new AbortController();
    const onStop = () => controller.abort();
    stopSignal?.addEventListener('abort', onStop, { once: true });
    if (stopSignal?.aborted) controller.abort();
    let sequence = claim.nextSequence;
    let leaseExpiresAt = Date.parse(claim.leaseExpiresAt);
    const leaseTtlMs = Math.max(3_000, leaseExpiresAt - Date.now());
    let messageChain: Promise<void> = Promise.resolve();
    const send = (kind: ExecutorMessageV1['kind'], data: Record<string, unknown> = {}) => {
      const pending = messageChain.then(async () => {
        if (controller.signal.aborted) throw new Error('Worker execution aborted');
        const message = {
          protocolVersion: EXECUTOR_PROTOCOL_VERSION,
          execution: dispatch.execution,
          leaseToken: claim.leaseToken,
          sequence,
          occurredAt: new Date().toISOString(),
          kind,
          ...data,
        };
        while (true) {
          try {
            const decision = await this.post(
              'executor-workers/messages',
              message,
              controller.signal,
            );
            if (!record(decision) || typeof decision.accepted !== 'boolean') {
              throw new Error('Invalid worker message response');
            }
            if (!decision.accepted && decision.code !== 'duplicate') {
              controller.abort();
              throw new Error(`Worker message rejected: ${String(decision.code)}`);
            }
            sequence += 1;
            if (kind === 'heartbeat') leaseExpiresAt = Date.now() + leaseTtlMs;
            return;
          } catch (error) {
            if (controller.signal.aborted || Date.now() >= leaseExpiresAt) {
              controller.abort();
              throw error;
            }
            await delay(200, undefined, { signal: controller.signal });
          }
        }
      });
      messageChain = pending.catch(() => undefined);
      return pending;
    };
    const interval = setInterval(
      () => {
        void send('heartbeat').catch(() => controller.abort());
      },
      Math.max(500, Math.floor(leaseTtlMs / 3)),
    );
    interval.unref?.();
    try {
      const plugin = this.plugins.get(dispatch.plugin.name);
      let result: PluginResult;
      if (
        !plugin ||
        plugin.version !== dispatch.plugin.version ||
        Object.keys(dispatch.secretRefs ?? {}).length > 0 ||
        dispatch.requiredCapabilities.length > 0
      ) {
        result = {
          success: false,
          code: PluginFailureCodes.PLUGIN_CONFIG_INVALID,
          message: 'Worker plugin, version, Secret, or capability is not allowed',
        };
      } else {
        try {
          result = await plugin.execute(dispatch.input.config, {
            ...dispatch.input.context,
            [PluginContextKeys.signal]: controller.signal,
          });
        } catch (error) {
          result = {
            success: false,
            code: PluginFailureCodes.PLUGIN_EXECUTION_ERROR,
            message: error instanceof Error ? error.message : 'Worker plugin failed',
          };
        }
      }
      clearInterval(interval);
      await messageChain;
      if (result.wait) {
        // This first worker has no execution.wait capability; never pretend the wait was persisted.
        result = {
          success: false,
          code: PluginFailureCodes.PLUGIN_CONFIG_INVALID,
          message: 'Worker wait is not enabled',
        };
      }
      await send('complete', { result });
    } finally {
      clearInterval(interval);
      stopSignal?.removeEventListener('abort', onStop);
      controller.abort();
    }
  }
}
