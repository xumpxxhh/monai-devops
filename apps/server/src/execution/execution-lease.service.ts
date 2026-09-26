import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type ExecutionCheckpoint,
  type ExecutionIdentity,
  type ExecutionWakeCondition,
} from '@monai-devops/core-engine';
import {
  EXECUTION_REPOSITORY,
  type ExecutionRepository,
  type WorkerTerminalResult,
} from './execution.repository.js';

interface ActiveLease {
  token: string;
  timer: ReturnType<typeof setInterval>;
}

@Injectable()
export class ExecutionLeaseService implements OnModuleDestroy {
  private readonly logger = new Logger(ExecutionLeaseService.name);
  private readonly active = new Map<string, ActiveLease>();
  private readonly ownerId: string;
  private readonly ttlMs: number;

  constructor(
    @Inject(EXECUTION_REPOSITORY) private readonly repository: ExecutionRepository,
    config: ConfigService,
  ) {
    this.ownerId = config.get<string>('EXECUTOR_ID', `server-${process.pid}`);
    this.ttlMs = Math.max(3_000, config.get<number>('EXECUTION_LEASE_TTL_MS', 30_000));
  }

  async start(execution: ExecutionIdentity): Promise<void> {
    if (this.active.has(execution.attemptId)) return;

    const token = randomUUID();
    const acquired = await this.repository.acquireLease(
      execution.attemptId,
      this.ownerId,
      token,
      new Date(Date.now() + this.ttlMs),
    );
    if (!acquired) {
      throw new Error(`Execution attempt lease unavailable: ${execution.attemptId}`);
    }
    const running = await this.repository.startLeasedAttempt(execution.attemptId, token);
    if (!running) {
      throw new Error(`Execution attempt could not enter running state: ${execution.attemptId}`);
    }

    const timer = setInterval(
      () => {
        void this.heartbeat(execution.attemptId, token);
      },
      Math.max(1_000, Math.floor(this.ttlMs / 3)),
    );
    timer.unref?.();
    this.active.set(execution.attemptId, { token, timer });
  }

  stop(attemptId: string): void {
    const lease = this.active.get(attemptId);
    if (!lease) return;
    clearInterval(lease.timer);
    this.active.delete(attemptId);
  }

  async registerWait(
    execution: ExecutionIdentity,
    checkpoint: ExecutionCheckpoint,
    condition: ExecutionWakeCondition,
  ): Promise<void> {
    const active = this.active.get(execution.attemptId);
    if (!active) {
      if (await this.repository.confirmRegisteredWorkerWait(execution, checkpoint, condition)) {
        return;
      }
      throw new Error(`Execution attempt cannot enter waiting: ${execution.attemptId}`);
    }
    if (
      !(await this.repository.registerWait({
        execution,
        leaseToken: active.token,
        checkpoint,
        condition,
      }))
    ) {
      throw new Error(`Execution attempt cannot enter waiting: ${execution.attemptId}`);
    }
    this.stop(execution.attemptId);
  }

  has(attemptId: string): boolean {
    return this.active.has(attemptId);
  }

  /** Return only a durable terminal receipt; abort promptly if the owning DAG stops. */
  async awaitWorkerTerminal(
    execution: ExecutionIdentity,
    runId: string,
    runLeaseToken: string,
    signal: AbortSignal,
    pollIntervalMs = 250,
  ): Promise<WorkerTerminalResult> {
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) {
      throw new Error('Invalid worker result polling interval');
    }
    const aborted = () => {
      if (signal.aborted) throw new Error(`Worker result wait aborted: ${execution.attemptId}`);
    };
    while (true) {
      aborted();
      const terminal = await this.repository.readWorkerTerminal(execution);
      aborted();
      if (terminal) return terminal;
      const timedOut = await this.repository.timeoutExpiredWorkerAttempt(
        execution,
        runId,
        runLeaseToken,
      );
      aborted();
      if (timedOut) throw new Error(`Worker lease expired: ${execution.attemptId}`);
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error(`Worker result wait aborted: ${execution.attemptId}`));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, pollIntervalMs);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    }
  }

  onModuleDestroy(): void {
    for (const attemptId of this.active.keys()) this.stop(attemptId);
  }

  private async heartbeat(attemptId: string, token: string): Promise<void> {
    try {
      const renewed = await this.repository.heartbeat(
        attemptId,
        token,
        new Date(Date.now() + this.ttlMs),
      );
      if (!renewed) {
        this.stop(attemptId);
        this.logger.warn(`Execution lease lost: ${attemptId}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Execution heartbeat failed for ${attemptId}: ${message}`);
    }
  }
}
