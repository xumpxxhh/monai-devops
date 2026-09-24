import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EXECUTION_REPOSITORY, type ExecutionRepository } from './execution.repository.js';

@Injectable()
export class ExecutionWakeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExecutionWakeService.name);
  private readonly pollMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;

  constructor(
    @Inject(EXECUTION_REPOSITORY) private readonly repository: ExecutionRepository,
    config: ConfigService,
  ) {
    this.pollMs = Math.max(100, config.get<number>('EXECUTION_WAKE_POLL_MS', 1000));
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    this.timer.unref?.();
    void this.poll();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async poll(now = new Date()): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const expired = await this.repository.expireWaits(now);
      const ready = await this.repository.wakeDueTimers(now);
      if (expired || ready) {
        this.logger.log(`Execution waits: ${ready} ready, ${expired} timed out`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Execution wait scan failed: ${message}`);
    } finally {
      this.polling = false;
    }
  }

  signal(attemptId: string, key: string, payload: unknown): Promise<boolean> {
    return this.repository.signalWait(attemptId, key, payload, new Date());
  }
}
