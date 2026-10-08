import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { EXECUTOR_PROTOCOL_VERSION } from '@monai-devops/core-engine';
import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import testPlugin from '@monai-devops/test-plugin';
import { assertTestDatabaseUrl } from '../common/storage/assert-test-database-url.js';
import { EngineService } from '../engine/engine.service.js';
import { ExecutionLeaseService } from '../execution/execution-lease.service.js';
import type { ExecutionRecoveryService } from '../execution/execution-recovery.service.js';
import { PrismaExecutionRepository } from '../execution/prisma-execution.repository.js';
import { EXECUTION_REPOSITORY } from '../execution/execution.repository.js';
import { WorkerTransportController } from '../execution/worker-transport.controller.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { WorkerClient } from '../worker/worker-client.js';
import { PrismaRunRepository } from './prisma-run.repository.js';
import { RunManagerService } from './run-manager.service.js';
import { RunRecoveryService } from './run-recovery.service.js';
import type { RunStreamService } from './run-stream.service.js';

const describeIfDb = process.env.DATABASE_URL?.trim() ? describe : describe.skip;

describeIfDb('remote worker HTTP/database integration', () => {
  jest.setTimeout(90_000);
  const token = `${randomUUID()}${randomUUID()}`;
  let workerLeaseTtlMs = 30_000;
  let allowedCapabilities = 'execution.wait';
  const config = {
    get: (key: string, fallback?: unknown) => {
      if (key === 'EXECUTOR_REMOTE_TEST_ENABLED') return true;
      if (key === 'EXECUTOR_WORKER_HTTP_TOKEN') return token;
      if (key === 'APP_ENV') return 'local-test';
      if (key === 'EXECUTOR_WORKER_LEASE_TTL_MS') return workerLeaseTtlMs;
      if (key === 'EXECUTOR_ALLOWED_CAPABILITIES') return allowedCapabilities;
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
    expect(run?.events.some((event) => event.type === 'plugin:log')).toBe(true);
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

  it('reconnects after a sustained message outage without changing the message sequence', async () => {
    const submitted = await manager.submitRun({
      id: 'remote-outage-integration',
      name: 'Remote outage integration',
      steps: [{ id: 'test', name: 'Remote test', plugin: 'test-plugin', config: { type: 'unit' } }],
    });
    const runId = submitted.runId;
    runIds.push(runId);
    const address = app.getHttpServer().address() as { port: number };
    let outageUntil = 0;
    let rejected = 0;
    let resumedSequence: number | undefined;
    const worker = new WorkerClient({
      serverUrl: `http://127.0.0.1:${address.port}/api/v1/devops`,
      token,
      workerId: 'outage-worker',
      plugins: [testPlugin],
      claimWaitMs: 5_000,
      fetchImpl: async (input, init) => {
        if (String(input).endsWith('/messages')) {
          const message = JSON.parse(String(init?.body)) as { sequence: number };
          if (outageUntil === 0) outageUntil = Date.now() + 1_200;
          if (Date.now() < outageUntil) {
            rejected += 1;
            throw new Error('simulated transport outage');
          }
          if (resumedSequence === undefined) resumedSequence = message.sequence;
        }
        return fetch(input, init);
      },
    });
    expect(await worker.runOnce()).toBe(true);
    expect(rejected).toBeGreaterThan(2);
    expect(resumedSequence).toBe(1);
    let run = await runs.findById(runId);
    for (let i = 0; i < 100 && run?.status !== 'finished'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      run = await runs.findById(runId);
    }
    expect(run?.status).toBe('finished');
    const messages = await prisma.executionAttemptMessage.findMany({
      where: { attempt: { job: { runId } } },
      orderBy: { sequence: 'asc' },
    });
    expect(messages.map((message) => message.sequence)).toEqual(
      Array.from({ length: messages.length }, (_, index) => index + 1),
    );
  });

  it('survives restart of the separate HTTP server process while the worker is running', async () => {
    const port = await new Promise<number>((resolve, reject) => {
      const socket = createServer();
      socket.once('error', reject);
      socket.listen(0, '127.0.0.1', () => {
        const address = socket.address();
        if (!address || typeof address === 'string') return reject(new Error('No test port'));
        socket.close(() => resolve(address.port));
      });
    });
    const startServer = async (): Promise<ChildProcess> => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'test/fixtures/worker-transport-server.ts'],
        {
          cwd: process.cwd(),
          env: { ...process.env, TEST_TRANSPORT_PORT: String(port), TEST_TRANSPORT_TOKEN: token },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        process.stderr.write(chunk);
      });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`Transport boot timeout: ${stderr}`)),
          10_000,
        );
        child.stdout?.on('data', (chunk: Buffer) => {
          if (!chunk.toString().includes('READY')) process.stderr.write(chunk);
          if (chunk.toString().includes('READY')) {
            clearTimeout(timeout);
            resolve();
          }
        });
        child.once('exit', (code) => {
          clearTimeout(timeout);
          reject(new Error(`Transport exited ${code}: ${stderr}`));
        });
      });
      return child;
    };
    const stopServer = async (child: ChildProcess) => {
      if (child.exitCode !== null) return;
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    };
    let server = await startServer();
    try {
      const submitted = await manager.submitRun({
        id: 'remote-server-restart-integration',
        name: 'Remote server restart integration',
        steps: [
          { id: 'test', name: 'Remote test', plugin: 'test-plugin', config: { type: 'unit' } },
        ],
      });
      const runId = submitted.runId;
      runIds.push(runId);
      const worker = new WorkerClient({
        serverUrl: `http://127.0.0.1:${port}/api/v1/devops`,
        token,
        workerId: 'restart-worker',
        plugins: [testPlugin],
        claimWaitMs: 5_000,
      });
      const work = worker.runOnce();
      let attempt = await prisma.executionAttempt.findFirst({ where: { job: { runId } } });
      for (let i = 0; i < 100 && attempt?.status !== 'running'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        attempt = await prisma.executionAttempt.findFirst({ where: { job: { runId } } });
      }
      expect(attempt?.status).toBe('running');
      await stopServer(server);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      server = await startServer();
      expect(await work).toBe(true);
      let run = await runs.findById(runId);
      for (let i = 0; i < 100 && run?.status !== 'finished'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        run = await runs.findById(runId);
      }
      expect(run?.status).toBe('finished');
      expect((await prisma.executionAttempt.findFirst({ where: { job: { runId } } }))?.status).toBe(
        'succeeded',
      );
    } finally {
      await stopServer(server);
    }
  });

  it('recovers a remote result after the Run owner and HTTP process restart together', async () => {
    const port = await new Promise<number>((resolve, reject) => {
      const socket = createServer();
      socket.once('error', reject);
      socket.listen(0, '127.0.0.1', () => {
        const address = socket.address();
        if (!address || typeof address === 'string') return reject(new Error('No test port'));
        socket.close(() => resolve(address.port));
      });
    });
    const start = async (): Promise<ChildProcess> => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'test/fixtures/full-remote-server.ts'],
        {
          cwd: process.cwd(),
          env: { ...process.env, TEST_TRANSPORT_PORT: String(port), TEST_TRANSPORT_TOKEN: token },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      let output = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`Full server boot timeout: ${output}`));
        }, 30_000);
        child.stdout?.on('data', (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes('READY')) {
            clearTimeout(timeout);
            resolve();
          }
        });
        child.once('exit', (code) => {
          clearTimeout(timeout);
          reject(new Error(`Full server exited ${code}: ${output}`));
        });
      });
      return child;
    };
    const stop = async (child: ChildProcess) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    };
    let server = await start();
    try {
      const base = `http://127.0.0.1:${port}/api/v1/devops`;
      const submitted = await fetch(`${base}/test-runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'remote-full-restart-integration',
          name: 'Remote full restart integration',
          steps: [
            { id: 'test', name: 'Remote test', plugin: 'test-plugin', config: { type: 'unit' } },
          ],
        }),
      });
      expect(submitted.ok).toBe(true);
      const { runId } = (await submitted.json()) as { runId: string };
      runIds.push(runId);
      const worker = new WorkerClient({
        serverUrl: base,
        token,
        workerId: 'full-restart-worker',
        plugins: [testPlugin],
        claimWaitMs: 5_000,
      });
      const work = worker.runOnce();
      let attempt = await prisma.executionAttempt.findFirst({ where: { job: { runId } } });
      for (let i = 0; i < 100 && attempt?.status !== 'running'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        attempt = await prisma.executionAttempt.findFirst({ where: { job: { runId } } });
      }
      expect(attempt?.status).toBe('running');
      await stop(server);
      await new Promise((resolve) => setTimeout(resolve, 3_500));
      server = await start();
      expect(await work).toBe(true);
      let run = await runs.findById(runId);
      for (let i = 0; i < 200 && run?.status !== 'finished'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        run = await runs.findById(runId);
      }
      expect(run?.status).toBe('finished');
      expect(run?.events.filter((event) => event.type === 'step:finished')).toHaveLength(1);
      expect((await prisma.executionAttempt.findFirst({ where: { job: { runId } } }))?.status).toBe(
        'succeeded',
      );
    } finally {
      await stop(server);
    }
  });

  it('persists a remote wait and resumes its new Attempt after a signal', async () => {
    const submitted = await manager.submitRun({
      id: 'remote-wait-integration',
      name: 'Remote wait integration',
      steps: [
        {
          id: 'test',
          name: 'Remote wait',
          plugin: 'test-plugin',
          config: { type: 'wait' },
          mayWait: true,
          retryPolicy: { maxAttempts: 2, backoffMs: 0 },
        },
      ],
    });
    const runId = submitted.runId;
    runIds.push(runId);
    const address = app.getHttpServer().address() as { port: number };
    const worker = new WorkerClient({
      serverUrl: `http://127.0.0.1:${address.port}/api/v1/devops`,
      token,
      workerId: 'wait-worker',
      plugins: [testPlugin],
      claimWaitMs: 5_000,
      fetchImpl: (input, init) =>
        fetch(input, { ...init, headers: { ...init?.headers, connection: 'close' } }),
    });
    expect(await worker.runOnce()).toBe(true);
    let run = await runs.findById(runId);
    for (let i = 0; i < 100 && run?.status !== 'waiting'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      run = await runs.findById(runId);
    }
    expect(run?.status).toBe('waiting');
    const first = await prisma.executionAttempt.findFirst({ where: { job: { runId } } });
    expect(first?.status).toBe('waiting');
    expect(
      await executions.signalWait(first!.attemptId, 'approved', { approved: true }, new Date()),
    ).toBe(true);
    for (let i = 0; i < 100; i++) {
      if (
        !(await prisma.run.findUnique({ where: { runId }, select: { leaseToken: true } }))
          ?.leaseToken &&
        !(manager as unknown as { managedRunIds: Set<string> }).managedRunIds.has(runId)
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect((manager as unknown as { managedRunIds: Set<string> }).managedRunIds.has(runId)).toBe(
      false,
    );
    expect((await prisma.run.findUnique({ where: { runId } }))?.leaseToken).toBeNull();
    const recovery = new RunRecoveryService(
      runs,
      { scanExpiredAttempts: async () => undefined } as ExecutionRecoveryService,
      manager,
      config,
    );
    let second = await prisma.executionAttempt.findFirst({ where: { job: { runId }, attempt: 1 } });
    for (let i = 0; i < 15 && !second?.dispatch; i++) {
      await recovery.scan();
      await new Promise((resolve) => setTimeout(resolve, 500));
      second = await prisma.executionAttempt.findFirst({ where: { job: { runId }, attempt: 1 } });
    }
    expect(second?.dispatch).toBeTruthy();
    expect(await worker.runOnce()).toBe(true);
    run = await runs.findById(runId);
    for (let i = 0; i < 100 && run?.status !== 'finished'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      run = await runs.findById(runId);
    }
    expect(run?.status).toBe('finished');
    expect(run?.result?.results[0]?.pluginResult?.data).toEqual({
      type: 'wait',
      message: '等待已唤醒',
    });
    expect(
      await prisma.executionAttempt.findMany({
        where: { job: { runId } },
        orderBy: { attempt: 'asc' },
        select: { status: true },
      }),
    ).toEqual([{ status: 'waiting' }, { status: 'succeeded' }]);
  });

  it('denies an unapproved capability before registering a worker dispatch', async () => {
    allowedCapabilities = '';
    try {
      const submitted = await manager.submitRun({
        id: 'remote-capability-denied-integration',
        name: 'Remote capability denial',
        steps: [
          {
            id: 'test',
            name: 'Remote wait',
            plugin: 'test-plugin',
            config: { type: 'wait' },
            mayWait: true,
            retryPolicy: { maxAttempts: 2, backoffMs: 0 },
          },
        ],
      });
      const runId = submitted.runId;
      runIds.push(runId);
      let run = await runs.findById(runId);
      for (let i = 0; i < 100 && run?.status !== 'failed'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        run = await runs.findById(runId);
      }
      expect(run?.status).toBe('failed');
      expect(
        run?.events.some((event) => JSON.stringify(event).includes('EXECUTOR_CAPABILITY_DENIED')),
      ).toBe(true);
      const attempts = await prisma.executionAttempt.findMany({ where: { job: { runId } } });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.dispatch).toBeNull();
    } finally {
      allowedCapabilities = 'execution.wait';
    }
  });

  it('projects a remote plugin failure and its log without turning it into infrastructure retry', async () => {
    const submitted = await manager.submitRun({
      id: 'remote-failure-integration',
      name: 'Remote failure integration',
      steps: [
        { id: 'test', name: 'Remote failure', plugin: 'test-plugin', config: { type: 'failure' } },
      ],
    });
    const runId = submitted.runId;
    runIds.push(runId);
    const address = app.getHttpServer().address() as { port: number };
    const worker = new WorkerClient({
      serverUrl: `http://127.0.0.1:${address.port}/api/v1/devops`,
      token,
      workerId: 'failure-worker',
      plugins: [testPlugin],
      claimWaitMs: 5_000,
    });
    expect(await worker.runOnce()).toBe(true);
    let run = await runs.findById(runId);
    for (let i = 0; i < 100 && run?.status !== 'failed'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      run = await runs.findById(runId);
    }
    expect(run?.status).toBe('failed');
    expect(run?.counts.failed).toBe(1);
    expect(run?.events.some((event) => event.type === 'plugin:log')).toBe(true);
    expect(await prisma.executionAttempt.findMany({ where: { job: { runId } } })).toHaveLength(1);
    expect((await prisma.executionAttempt.findFirst({ where: { job: { runId } } }))?.status).toBe(
      'failed',
    );
  });

  it('fences a hard-cancelled remote Attempt and rejects its late completion', async () => {
    const submitted = await manager.submitRun({
      id: 'remote-hard-cancel-integration',
      name: 'Remote hard cancel integration',
      steps: [
        { id: 'test', name: 'Remote cancel', plugin: 'test-plugin', config: { type: 'unit' } },
      ],
    });
    const runId = submitted.runId;
    runIds.push(runId);
    let dispatch = await prisma.executionAttempt.findFirst({ where: { job: { runId } } });
    for (let i = 0; i < 100 && !dispatch?.dispatch; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      dispatch = await prisma.executionAttempt.findFirst({ where: { job: { runId } } });
    }
    expect(dispatch?.dispatch).toBeTruthy();
    const assignment = await executions.claimWorkerDispatch('cancel-worker', workerLeaseTtlMs, [
      { name: 'test-plugin', version: '1.0.0', capabilities: ['execution.wait'] },
    ]);
    expect(assignment?.dispatch.runId).toBe(runId);
    await engine.cancelRun(runId, 'hard');
    let attempt = await prisma.executionAttempt.findUnique({
      where: { attemptId: dispatch!.attemptId },
    });
    for (let i = 0; i < 100 && attempt?.status !== 'cancelled'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      attempt = await prisma.executionAttempt.findUnique({
        where: { attemptId: dispatch!.attemptId },
      });
    }
    expect(attempt?.status).toBe('cancelled');
    expect(
      (await prisma.executionJob.findUnique({ where: { jobId: dispatch!.jobId } }))?.status,
    ).toBe('cancelled');
    const late = await executions.acceptRegisteredWorkerMessage(
      {
        protocolVersion: EXECUTOR_PROTOCOL_VERSION,
        execution: assignment!.dispatch.execution,
        leaseToken: assignment!.claim.leaseToken,
        sequence: assignment!.claim.nextSequence,
        occurredAt: new Date().toISOString(),
        kind: 'complete',
        result: { success: true },
      },
      workerLeaseTtlMs,
    );
    expect(late.accepted).toBe(false);
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
