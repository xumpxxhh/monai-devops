import { Global, Module } from '@nestjs/common';
import { PrismaRunRepository } from './prisma-run.repository.js';
import { RunManagerService } from './run-manager.service.js';
import { RunStreamService } from './run-stream.service.js';
import { RUN_REPOSITORY } from './runs.repository.js';
import { RunsController } from './runs.controller.js';
import { RunsGateway } from './runs.gateway.js';
import { EXECUTION_REPOSITORY } from '../execution/execution.repository.js';
import { PrismaExecutionRepository } from '../execution/prisma-execution.repository.js';
import { ExecutionLeaseService } from '../execution/execution-lease.service.js';
import { ExecutionRecoveryService } from '../execution/execution-recovery.service.js';
import { ExecutionControlService } from '../execution/execution-control.service.js';
import { ExecutionWakeService } from '../execution/execution-wake.service.js';
import { RunRecoveryService } from './run-recovery.service.js';

@Global()
@Module({
  controllers: [RunsController],
  providers: [
    PrismaRunRepository,
    PrismaExecutionRepository,
    { provide: RUN_REPOSITORY, useExisting: PrismaRunRepository },
    { provide: EXECUTION_REPOSITORY, useExisting: PrismaExecutionRepository },
    ExecutionLeaseService,
    ExecutionRecoveryService,
    ExecutionControlService,
    ExecutionWakeService,
    RunManagerService,
    RunRecoveryService,
    RunStreamService,
    RunsGateway,
  ],
  exports: [RunManagerService, RunStreamService, RUN_REPOSITORY, EXECUTION_REPOSITORY],
})
export class RunsModule {}
