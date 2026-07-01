import { Inject, Injectable } from '@nestjs/common';
import { EngineService } from '../engine/engine.service.js';
import { type RunRepository, RUN_REPOSITORY } from '../runs/runs.repository.js';

@Injectable()
export class StatsService {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runRepository: RunRepository,
    private readonly engineService: EngineService,
  ) {}

  async overview() {
    const [active, finished, failed, queue] = await Promise.all([
      this.runRepository.countActive(),
      this.runRepository.countByStatus('finished'),
      this.runRepository.countByStatus('failed'),
      Promise.resolve(this.engineService.getQueueStatus()),
    ]);

    const terminal = finished + failed;
    const successRate = terminal > 0 ? finished / terminal : null;

    return {
      activeRuns: active,
      finishedRuns: finished,
      failedRuns: failed,
      successRate,
      pluginCount: this.engineService.getPluginCount(),
      queue,
    };
  }
}
