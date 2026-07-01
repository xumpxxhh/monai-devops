import { Module } from '@nestjs/common';
import { RunsModule } from '../runs/runs.module.js';
import { StatsController } from './stats.controller.js';
import { StatsService } from './stats.service.js';

@Module({
  imports: [RunsModule],
  controllers: [StatsController],
  providers: [StatsService],
})
export class StatsModule {}
