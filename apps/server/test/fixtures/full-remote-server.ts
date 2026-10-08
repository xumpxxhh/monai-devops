import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { WorkflowDefinition } from '@monai-devops/core-engine';
import { EngineService } from '../../src/engine/engine.service.js';
import { ExecutionLeaseService } from '../../src/execution/execution-lease.service.js';
import type { ExecutionRecoveryService } from '../../src/execution/execution-recovery.service.js';
import { EXECUTION_REPOSITORY } from '../../src/execution/execution.repository.js';
import { PrismaExecutionRepository } from '../../src/execution/prisma-execution.repository.js';
import { WorkerTransportController } from '../../src/execution/worker-transport.controller.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { PrismaRunRepository } from '../../src/runs/prisma-run.repository.js';
import { RunManagerService } from '../../src/runs/run-manager.service.js';
import { RunRecoveryService } from '../../src/runs/run-recovery.service.js';
import type { RunStreamService } from '../../src/runs/run-stream.service.js';

const port = Number(process.env.TEST_TRANSPORT_PORT);
const token = process.env.TEST_TRANSPORT_TOKEN;
if (!Number.isInteger(port) || port < 1 || !token) {
  throw new Error('Test transport port or token is missing');
}

@Controller('test-runs')
class TestRunsController {
  constructor(@Inject(RunManagerService) private readonly manager: RunManagerService) {}

  @Post()
  submit(@Body() workflow: WorkflowDefinition) {
    return this.manager.submitRun(workflow);
  }

  @Get(':runId')
  get(@Param('runId') runId: string) {
    return this.manager.getRun(runId);
  }
}

async function main(): Promise<void> {
  const config = {
    get: (key: string, fallback?: unknown) => {
      if (key === 'EXECUTOR_REMOTE_TEST_ENABLED') return true;
      if (key === 'EXECUTOR_WORKER_HTTP_TOKEN') return token;
      if (key === 'APP_ENV') return 'local-test';
      if (key === 'RUN_LEASE_TTL_MS') return 3_000;
      if (key === 'RUN_RECOVERY_POLL_MS') return 1_000;
      if (key === 'EXECUTOR_ALLOWED_CAPABILITIES') return 'execution.wait';
      return fallback;
    },
  } as ConfigService;
  const prisma = new PrismaService();
  await prisma.$connect();
  const runs = new PrismaRunRepository(prisma, config);
  const executions = new PrismaExecutionRepository(prisma);
  const leases = new ExecutionLeaseService(executions, config);
  const engine = new EngineService(config);
  const manager = new RunManagerService(
    engine,
    runs,
    { fanOut: () => undefined } as unknown as RunStreamService,
    config,
    executions,
    leases,
    { request: () => undefined, setResumePersistedRun: () => undefined } as never,
  );
  const recovery = new RunRecoveryService(
    runs,
    { scanExpiredAttempts: async () => undefined } as ExecutionRecoveryService,
    manager,
    config,
  );
  const module = await Test.createTestingModule({
    controllers: [WorkerTransportController, TestRunsController],
    providers: [
      { provide: EXECUTION_REPOSITORY, useValue: executions },
      { provide: ConfigService, useValue: config },
      { provide: RunManagerService, useValue: manager },
    ],
  }).compile();
  const app = module.createNestApplication();
  app.setGlobalPrefix('api/v1/devops');
  engine.onModuleInit();
  manager.onModuleInit();
  await app.listen(port, '127.0.0.1');
  await recovery.onApplicationBootstrap();
  process.stdout.write('READY\n');
  process.on('SIGTERM', () => {
    recovery.onModuleDestroy();
    manager.onModuleDestroy();
    leases.onModuleDestroy();
    engine.onModuleDestroy();
    void app.close().finally(() => prisma.$disconnect().finally(() => process.exit(0)));
  });
}

void main().catch((error: unknown) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
