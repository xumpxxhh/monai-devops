import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { RunControlResult } from '@monai-devops/core-engine';
import { EngineService } from '../engine/engine.service.js';
import { RUN_REPOSITORY, type RunRepository } from '../runs/runs.repository.js';
import {
  EXECUTION_REPOSITORY,
  type ExecutionControlCommand,
  type ExecutionControlType,
  type ExecutionRepository,
} from './execution.repository.js';

export interface RequestedExecutionControl {
  commandId: string;
  status: 'pending' | 'applied' | 'rejected';
  result?: RunControlResult;
  error?: string;
}

@Injectable()
export class ExecutionControlService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExecutionControlService.name);
  private readonly ownerId: string;
  private readonly pollMs: number;
  private readonly claimTtlMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private draining = false;

  constructor(
    private readonly engine: EngineService,
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(EXECUTION_REPOSITORY) private readonly executions: ExecutionRepository,
    config: ConfigService,
  ) {
    this.ownerId = config.get<string>('EXECUTOR_ID', `server-${process.pid}`);
    this.pollMs = Math.max(100, config.get<number>('EXECUTION_CONTROL_POLL_MS', 500));
    this.claimTtlMs = Math.max(3_000, config.get<number>('EXECUTION_CONTROL_CLAIM_TTL_MS', 30_000));
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.drain(), this.pollMs);
    this.timer.unref?.();
    void this.drain();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async request(
    runId: string,
    type: ExecutionControlType,
    payload: Record<string, unknown> = {},
  ): Promise<RequestedExecutionControl> {
    const command: ExecutionControlCommand = {
      commandId: randomUUID(),
      runId,
      type,
      payload,
      status: 'pending',
      requestedAt: new Date(),
    };
    await this.executions.enqueueControl(command);
    return this.tryApply(command);
  }

  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const commands = await this.executions.listClaimableControls(this.staleBefore(), 50);
      for (const command of commands) await this.tryApply(command);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Execution control poll failed: ${message}`);
    } finally {
      this.draining = false;
    }
  }

  private staleBefore(): Date {
    return new Date(Date.now() - this.claimTtlMs);
  }

  private async tryApply(command: ExecutionControlCommand): Promise<RequestedExecutionControl> {
    const record = await this.runs.findById(command.runId);

    if (!record) {
      return this.reject(command, 'Run does not exist');
    }

    if (!this.engine.isReady()) {
      if (command.type === 'cancel' && record.status === 'queued') {
        return this.applyQueuedCancel(command);
      }
      return { commandId: command.commandId, status: 'pending' };
    }

    const engineStatus = this.engine.getRunStatus(command.runId);

    if (!engineStatus || engineStatus.status === 'unknown') {
      if (command.type === 'cancel' && record.status === 'queued') {
        return this.applyQueuedCancel(command);
      }
      if (['finished', 'failed', 'rejected', 'cancelled'].includes(record.status)) {
        return this.reject(command, `Run is already ${record.status}`);
      }
      return { commandId: command.commandId, status: 'pending' };
    }

    const claimed = await this.executions.claimControl(
      command.commandId,
      this.ownerId,
      this.staleBefore(),
    );
    if (!claimed) return { commandId: command.commandId, status: 'pending' };

    try {
      const result = await this.applyToEngine(command);
      await this.projectResult(command, result);
      await this.executions.completeControl(command.commandId, this.ownerId, 'applied');
      return { commandId: command.commandId, status: 'applied', result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.executions.completeControl(command.commandId, this.ownerId, 'rejected', message);
      this.logger.warn(`Execution control ${command.commandId} rejected: ${message}`);
      return { commandId: command.commandId, status: 'rejected', error: message };
    }
  }

  private async applyQueuedCancel(
    command: ExecutionControlCommand,
  ): Promise<RequestedExecutionControl> {
    const claimed = await this.executions.claimControl(
      command.commandId,
      this.ownerId,
      this.staleBefore(),
    );
    if (!claimed) return { commandId: command.commandId, status: 'pending' };

    const mode = command.payload.mode === 'hard' ? 'hard' : 'best-effort';
    await this.runs.update(command.runId, {
      status: 'cancelled',
      cancelled: mode,
      finishedAt: new Date(),
    });
    await this.executions.completeControl(command.commandId, this.ownerId, 'applied');
    return { commandId: command.commandId, status: 'applied' };
  }

  private async reject(
    command: ExecutionControlCommand,
    message: string,
  ): Promise<RequestedExecutionControl> {
    const claimed = await this.executions.claimControl(
      command.commandId,
      this.ownerId,
      this.staleBefore(),
    );
    if (!claimed) return { commandId: command.commandId, status: 'pending' };
    await this.executions.completeControl(command.commandId, this.ownerId, 'rejected', message);
    return { commandId: command.commandId, status: 'rejected', error: message };
  }

  private applyToEngine(command: ExecutionControlCommand): Promise<RunControlResult> {
    if (command.type === 'cancel') {
      const mode = command.payload.mode === 'hard' ? 'hard' : 'best-effort';
      return this.engine.cancelRun(command.runId, mode);
    }
    if (command.type === 'pause') {
      return this.engine.pauseRun(command.runId, {
        waitInFlight: command.payload.waitInFlight !== false,
        abortInFlight: command.payload.abortInFlight === true,
      });
    }
    return this.engine.resumeRun(command.runId);
  }

  private async projectResult(
    command: ExecutionControlCommand,
    result: RunControlResult,
  ): Promise<void> {
    if (result.currentStatus === 'unknown') {
      throw new Error('Run ownership changed before the control command was applied');
    }
    if (command.type === 'cancel') {
      const mode = command.payload.mode === 'hard' ? 'hard' : 'best-effort';
      if (result.currentStatus === 'cancelled') {
        await this.runs.update(command.runId, {
          status: 'cancelled',
          cancelled: mode,
          finishedAt: new Date(),
        });
      } else if (result.currentStatus === 'cancelling') {
        await this.runs.update(command.runId, { status: 'running', cancelled: mode });
      }
      return;
    }
    if (command.type === 'pause' && ['paused', 'pausing'].includes(result.currentStatus)) {
      await this.runs.update(command.runId, {
        status: result.currentStatus === 'paused' ? 'paused' : 'pausing',
      });
      return;
    }
    if (command.type === 'resume' && result.currentStatus === 'running') {
      await this.runs.update(command.runId, { status: 'running' });
    }
  }
}
