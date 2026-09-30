import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
  jest.setTimeout(60_000);
  const token = `${randomUUID()}${randomUUID()}`;
  let workerLeaseTtlMs = 30_000;
  const config = {
    get: (key: string, fallback?: unknown) => {
      if (key === 'EXECUTOR_REMOTE_TEST_ENABLED') return true;
      if (key === 'EXECUTOR_WORKER_HTTP_TOKEN') return token;
      if (key === 'APP_ENV') return 'local-test';
      if (key === 'EXECUTOR_WORKER_LEASE_TTL_MS') return workerLeaseTtlMs;
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

  it('retries a lost completion response with the same sequence without double settlement', async () => {
    const submitted = await manager.submitRun({
      id: 'remote-lost-response-integration',
      name: 'Remote lost response integration',
      steps: [{ id: 'test', name: 'Remote test', plugin: 'test-plugin', config: { type: 'unit' } }],
    });
    const runId = submitted.runId;
    runIds.push(runId);
    const address = app.getHttpServer().address() as { port: number };
    const completions: Array<{ sequence: number; decision: { accepted: boolean; code?: string } }> =
      [];
    const worker = new WorkerClient({
      serverUrl: `http://127.0.0.1:${address.port}/api/v1/devops`,
      token,
      workerId: 'lost-response-worker',
      plugins: [testPlugin],
      claimWaitMs: 5_000,
      fetchImpl: async (input, init) => {
        const response = await fetch(input, {
          ...init,
          headers: { ...init?.headers, connection: 'close' },
        });
        if (!String(input).endsWith('/messages')) return response;
        const message = JSON.parse(String(init?.body)) as { kind: string; sequence: number };
        if (message.kind !== 'complete') return response;
        const decision = (await response.clone().json()) as {
          accepted: boolean;
          code?: string;
        };
        completions.push({ sequence: message.sequence, decision });
        if (completions.length === 1) throw new Error('completion response lost after commit');
        return response;
      },
    });
    expect(await worker.runOnce()).toBe(true);
    expect(completions).toMatchObject([
      { sequence: expect.any(Number), decision: { accepted: true } },
      { sequence: expect.any(Number), decision: { accepted: false, code: 'duplicate' } },
    ]);
    expect(completions[1]?.sequence).toBe(completions[0]?.sequence);

    let run = await runs.findById(runId);
    for (let i = 0; i < 100 && run?.status !== 'finished'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      run = await runs.findById(runId);
    }
    expect(run?.status).toBe('finished');
    expect(run?.counts.completed).toBe(1);
    expect(run?.events.filter((event) => event.type === 'step:finished')).toHaveLength(1);
    const attempt = await prisma.executionAttempt.findFirst({ where: { job: { runId } } });
    expect(attempt?.status).toBe('succeeded');
    expect(
      await prisma.executionAttemptMessage.count({
        where: { attemptId: attempt?.attemptId, kind: 'complete' },
      }),
    ).toBe(1);
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
      worker.kill('SIGKILL');
      if (worker.exitCode === null) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Worker process did not exit')), 3_000);
          worker.once('exit', () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      }
      if (stderr) process.stderr.write(stderr);
      // A claim already authorized before process exit may remain in the server's long poll.
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    }
  });

  it('fences a crashed worker after its lease expires and rejects a late completion', async () => {
    workerLeaseTtlMs = 3_000;
    const submitted = await manager.submitRun({
      id: 'remote-crash-integration',
      name: 'Remote crash integration',
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
        EXECUTOR_WORKER_ID: 'crashing-process-worker',
        EXECUTOR_WORKER_CLAIM_WAIT_MS: '1000',
      },
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      let attempt = await prisma.executionAttempt.findFirst({ where: { job: { runId } } });
      for (let i = 0; i < 100 && attempt?.leaseOwner !== 'crashing-process-worker'; i++) {
        if (worker.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
        attempt = await prisma.executionAttempt.findFirst({ where: { job: { runId } } });
      }
      expect(attempt?.leaseOwner).toBe('crashing-process-worker');
      expect(attempt?.leaseToken).toBeTruthy();
      expect(worker.exitCode).toBeNull();
      const leaseToken = attempt!.leaseToken!;
      const sequence = attempt!.messageSequence + 1;
      worker.kill('SIGKILL');
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Crashed worker did not exit')), 3_000);
        worker.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      let run = await runs.findById(runId);
      for (let i = 0; i < 160 && run?.status === 'running'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        run = await runs.findById(runId);
      }
      expect(run?.status).toBe('failed');
      const settled = await prisma.executionAttempt.findUnique({
        where: { attemptId: attempt!.attemptId },
      });
      expect(settled?.status).toBe('timed_out');

      const late = await fetch(
        `http://127.0.0.1:${address.port}/api/v1/devops/executor-workers/messages`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            connection: 'close',
          },
          body: JSON.stringify({
            protocolVersion: 1,
            execution: { jobId: attempt!.jobId, attemptId: attempt!.attemptId, attempt: 0 },
            leaseToken,
            sequence,
            occurredAt: new Date().toISOString(),
            kind: 'complete',
            result: { success: true, data: { forged: true } },
          }),
        },
      );
      expect(late.ok).toBe(true);
      expect(((await late.json()) as { accepted: boolean }).accepted).toBe(false);
      expect(
        await prisma.executionAttemptMessage.findFirst({
          where: { attemptId: attempt!.attemptId, kind: 'complete' },
        }),
      ).toBeNull();
    } finally {
      workerLeaseTtlMs = 30_000;
      if (worker.exitCode === null) worker.kill('SIGKILL');
    }
  });
});
