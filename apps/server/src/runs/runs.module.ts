import { Global, Module } from '@nestjs/common';
import { PrismaRunRepository } from './prisma-run.repository.js';
import { RunManagerService } from './run-manager.service.js';
import { RunStreamService } from './run-stream.service.js';
import { RUN_REPOSITORY } from './runs.repository.js';
import { RunsController } from './runs.controller.js';
import { RunsGateway } from './runs.gateway.js';

@Global()
@Module({
  controllers: [RunsController],
  providers: [
    PrismaRunRepository,
    { provide: RUN_REPOSITORY, useExisting: PrismaRunRepository },
    RunManagerService,
    RunStreamService,
    RunsGateway,
  ],
  exports: [RunManagerService, RunStreamService, RUN_REPOSITORY],
})
export class RunsModule {}
