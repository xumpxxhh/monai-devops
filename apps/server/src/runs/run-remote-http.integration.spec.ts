import { spawn } from 'node:child_process';
import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import testPlugin from '@monai-devops/test-plugin';
import { assertTestDatabaseUrl } from '../common/storage/assert-test-database-url.js';
import { EngineService } from '../engine/engine.service.js';
import { ExecutionLeaseService } from '../execution/execution-lease.service.js';
import { PrismaExecutionRepository } from '../execution/prisma-execution.repository.js';
import { EXECUTION_REPOSITORY } from '../execution/execution.repository.js';
import { WorkerTransportController } from '../execution/worker-transport.controller.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { WorkerClient } from '../worker/worker-client.js';
import { PrismaRunRepository } from './prisma-run.repository.js';
import { RunManagerService } from './run-manager.service.js';
import type { RunStreamService } from './run-stream.service.js';

const describeIfDb = process.env.DATABASE_URL?.trim() ? describe : describe.skip;

describeIfDb('remote worker HTTP/database integration', () => {
  jest.setTimeout(45_000);
  const token = 'integration-worker-token-at-least-32-characters';
  const config = {
    get: (key: string, fallback?: unknown) => {
      if (key === 'EXECUTOR_REMOTE_TEST_ENABLED') return true;
      if (key === 'EXECUTOR_WORKER_HTTP_TOKEN') return token;
      if (key === 'APP_ENV') return 'local-test';
      return fallback;
    },
  } as ConfigService;
  const prisma = new PrismaService();
  const runs = new PrismaRunRepository(prisma, config);
  const executions = new PrismaExecutionRepository(prisma);
  const leases = new ExecutionLeaseService(executions, config);
  const engine = new EngineService(config);
  const manager = new RunManagerService(
    engine,
    runs,
    { fanOut: jest.fn() } as unknown as RunStreamService,
    config,
    executions,
    leases,
    { request: jest.fn() } as never,
  );
  let app: NestExpressApplication;
  const runIds: string[] = [];

  beforeAll(async () => {
    assertTestDatabaseUrl();
    await prisma.$connect();
    const module = await Test.createTestingModule({
      controllers: [WorkerTransportController],
      providers: [
        { provide: EXECUTION_REPOSITORY, useValue: executions },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    app = module.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api/v1/devops');
    await app.listen(0, '127.0.0.1');
    engine.onModuleInit();
    manager.onModuleInit();
  });

  afterAll(async () => {
    manager.onModuleDestroy();
    leases.onModuleDestroy();
    engine.onModuleDestroy();
    if (app) await app.close();
    if (runIds.length) await prisma.run.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.$disconnect();
  });

  it('claims a queued Attempt over HTTP and returns its durable result to the DAG', async () => {
    const submitted = await manager.submitRun({
      id: 'remote-http-integration',
      name: 'Remote HTTP integration',
      steps: [{ id: 'test', name: 'Remote test', plugin: 'test-plugin', config: { type: 'unit' } }],
    });
    const runId = submitted.runId;
    runIds.push(runId);
    const address = app.getHttpServer().address() as { port: number };
    const worker = new WorkerClient({
      serverUrl: `http://127.0.0.1:${address.port}/api/v1/devops`,
      token,
      workerId: 'integration-worker',
      plugins: [testPlugin],
      claimWaitMs: 5_000,
      fetchImpl: (input, init) =>
        fetch(input, { ...init, headers: { ...init?.headers, connection: 'close' } }),
    });
    expect(await worker.runOnce()).toBe(true);

    let run = await runs.findById(runId);
    for (let i = 0; i < 100 && run?.status !== 'finished'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      run = await runs.findById(runId);
    }
    expect(run?.status).toBe('finished');
    expect(run?.counts.completed).toBe(1);
    expect(run?.result?.results[0]?.pluginResult?.data).toEqual({
      type: 'unit',
      message: '单元测试执行成功',
    });
    const attempt = await prisma.executionAttempt.findFirst({ where: { job: { runId } } });
    expect(attempt?.status).toBe('succeeded');
    expect(attempt?.messageSequence).toBeGreaterThan(0);
    expect(
      await prisma.executionAttemptMessage.findFirst({
        where: { attemptId: attempt?.attemptId, kind: 'complete' },
      }),
    ).not.toBeNull();
  });

  it('runs the real worker entrypoint in a separate process', async () => {
    const submitted = await manager.submitRun({
      id: 'remote-process-integration',
      name: 'Remote process integration',
      steps: [{ id: 'test', name: 'Remote test', plugin: 'test-plugin', config: { type: 'unit' } }],
    });
    const runId = submitted.runId;
    runIds.push(runId);
    const address = app.getHttpServer().address() as { port: number };
    const worker = spawn(process.execPath, ['--import', 'tsx', 'src/worker/main.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        EXECUTOR_SERVER_URL: `http://127.0.0.1:${address.port}/api/v1/devops`,
        EXECUTOR_WORKER_HTTP_TOKEN: token,
        EXECUTOR_WORKER_ALLOWED_PLUGINS: 'test-plugin',
        EXECUTOR_WORKER_ID: 'integration-process-worker',
        EXECUTOR_WORKER_CLAIM_WAIT_MS: '1000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    worker.stdout.resume();
    worker.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    try {
      let run = await runs.findById(runId);
      for (let i = 0; i < 300 && run?.status !== 'finished'; i++) {
        if (worker.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
        run = await runs.findById(runId);
      }
      expect(worker.exitCode).toBeNull();
      expect(run?.status).toBe('finished');
      expect(run?.counts.completed).toBe(1);
      const attempt = await prisma.executionAttempt.findFirst({ where: { job: { runId } } });
      expect(attempt?.status).toBe('succeeded');
      expect(
        await prisma.executionAttemptMessage.findFirst({
          where: { attemptId: attempt?.attemptId, kind: 'complete' },
        }),
      ).not.toBeNull();
    } finally {
      worker.kill();
      if (worker.exitCode === null) {
        await Promise.race([
          new Promise<void>((resolve) => worker.once('exit', () => resolve())),
          new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
        ]);
      }
      if (stderr) process.stderr.write(stderr);
    }
  });
});
