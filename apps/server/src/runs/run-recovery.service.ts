import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExecutionRecoveryService } from '../execution/execution-recovery.service.js';
import { RunManagerService } from './run-manager.service.js';
import { RUN_REPOSITORY, type RunRepository } from './runs.repository.js';

/** 周期扫描失联 Run；只分发已通过独占认领和快照校验的执行。 */
@Injectable()
export class RunRecoveryService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RunRecoveryService.name);
  private readonly pollMs: number;
  private readonly batchSize: number;
  private readonly blockedReasons = new Map<string, { reason: string; retryAt: number }>();
  private timer?: ReturnType<typeof setInterval>;
  private scanning = false;

  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    private readonly attempts: ExecutionRecoveryService,
    private readonly manager: RunManagerService,
    config: ConfigService,
  ) {
    this.pollMs = Math.max(1_000, config.get<number>('RUN_RECOVERY_POLL_MS', 5_000));
    this.batchSize = Math.max(1, config.get<number>('RUN_RECOVERY_BATCH_SIZE', 50));
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.scan();
    this.timer = setInterval(() => void this.scan(), this.pollMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      await this.attempts.scanExpiredAttempts();
      const now = new Date();
      const excluded: string[] = [];
      for (const [runId, blocked] of this.blockedReasons) {
        if (blocked.retryAt > now.getTime()) excluded.push(runId);
        else this.blockedReasons.delete(runId);
      }
      const candidates = await this.runs.listRecoverableRunIds(
        now,
        new Date(now.getTime() - this.pollMs),
        this.batchSize,
        excluded,
      );
      for (const runId of candidates) {
        try {
          if (await this.manager.resumePersistedRun(runId)) {
            this.blockedReasons.delete(runId);
            this.logger.log(`Resumed Run under recovered ownership: ${runId}`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (this.blockedReasons.get(runId)?.reason !== message) {
            this.logger.warn(`Run ${runId} remains unrecovered: ${message}`);
          }
          this.blockedReasons.set(runId, {
            reason: message,
            retryAt: Date.now() + Math.max(30_000, this.pollMs * 6),
          });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Run recovery scan failed: ${message}`);
    } finally {
      this.scanning = false;
    }
  }
}
