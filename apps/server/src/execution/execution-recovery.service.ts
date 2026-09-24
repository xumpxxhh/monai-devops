import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AttemptStatuses } from '@monai-devops/core-engine';
import { EXECUTION_REPOSITORY, type ExecutionRepository } from './execution.repository.js';

@Injectable()
export class ExecutionRecoveryService implements OnModuleInit {
  private readonly logger = new Logger(ExecutionRecoveryService.name);

  constructor(@Inject(EXECUTION_REPOSITORY) private readonly repository: ExecutionRepository) {}

  async onModuleInit(): Promise<void> {
    await this.scanExpiredAttempts();
  }

  async scanExpiredAttempts(): Promise<void> {
    try {
      const recoverable = await this.repository.listRecoverable(new Date());
      for (const attempt of recoverable) {
        if (attempt.status === AttemptStatuses.WAITING) continue;
        const timedOut = await this.repository.timeoutExpiredAttempt(
          attempt.attemptId,
          new Date(),
          {
            code: 'executor_lease_expired',
            category: 'infrastructure',
            message: 'Executor lease expired before service recovery',
          },
        );
        if (timedOut) {
          this.logger.warn(
            `Recovered expired execution attempt as timed out: ${attempt.attemptId}`,
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Execution recovery scan failed: ${message}`);
    }
  }
}
