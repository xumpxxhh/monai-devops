import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EXECUTION_REPOSITORY, type ExecutionRepository } from './execution.repository.js';

@Injectable()
export class ExecutorObjectCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExecutorObjectCleanupService.name);
  private timer?: ReturnType<typeof setInterval>;
  private cancellationTimer?: ReturnType<typeof setInterval>;

  constructor(@Inject(EXECUTION_REPOSITORY) private readonly repository: ExecutionRepository) {}

  onModuleInit(): void {
    void this.cleanup();
    this.timer = setInterval(() => void this.cleanup(), 60 * 60_000);
    this.timer.unref?.();
    this.cancellationTimer = setInterval(() => void this.fenceCancellations(), 250);
    this.cancellationTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.cancellationTimer) clearInterval(this.cancellationTimer);
  }

  private async cleanup(): Promise<void> {
    try {
      const removed = await this.repository.cleanupExpiredWorkerObjects(new Date());
      if (removed > 0) this.logger.log(`Removed ${removed} expired executor objects`);
    } catch (error) {
      this.logger.error(
        `Executor object cleanup failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }

  private async fenceCancellations(): Promise<void> {
    try {
      await this.repository.fenceExpiredWorkerCancellations();
    } catch (error) {
      this.logger.error(
        `Executor cancellation fencing failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }
}
