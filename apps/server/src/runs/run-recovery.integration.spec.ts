import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import { getContext, PluginContextKeys } from '@monai-devops/plugin-sdk';
import {
  AttemptStatuses,
  createExecutionIdentity,
  createWorkflowExecutor,
  SkipReasons,
  StepStatuses,
  WorkflowContextKeys,
  type WorkflowDefinition,
  type WorkflowLifecycleEvent,
} from '@monai-devops/core-engine';
import { assertTestDatabaseUrl } from '../common/storage/assert-test-database-url.js';
import type { EngineService } from '../engine/engine.service.js';
import { ExecutionLeaseService } from '../execution/execution-lease.service.js';
import { ExecutionControlService } from '../execution/execution-control.service.js';
import { ExecutionRecoveryService } from '../execution/execution-recovery.service.js';
import { PrismaExecutionRepository } from '../execution/prisma-execution.repository.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PrismaRunRepository } from './prisma-run.repository.js';
import { RunManagerService } from './run-manager.service.js';
import { RunRecoveryService } from './run-recovery.service.js';
import type { RunStreamService } from './run-stream.service.js';
import type { RunRepository } from './runs.repository.js';

const describeIfDb = process.env.DATABASE_URL?.trim() ? describe : describe.skip;

describeIfDb('Run recovery integration', () => {
  const prisma = new PrismaService();
  const config = {
    get: jest.fn((_key: string, fallback?: unknown) => fallback),
  } as unknown as ConfigService;
  const runs = new PrismaRunRepository(prisma, config);
  const executions = new PrismaExecutionRepository(prisma);
  let runId: string;

  beforeAll(async () => {
    assertTestDatabaseUrl();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  afterEach(async () => {
    if (runId) await prisma.run.deleteMany({ where: { runId } });
  });

  it('skips completed work and creates Attempt 1 for the lost step', async () => {
    runId = randomUUID();
    const workflow: WorkflowDefinition = {
      id: 'recovery-integration',
      name: 'Recovery integration',
      steps: [
        { id: 'a', name: 'A', plugin: 'test', config: {} },
        {
          id: 'b',
          name: 'B',
          plugin: 'test',
          config: {},
          dependsOn: ['a'],
          retryPolicy: { maxAttempts: 2, backoffMs: 0 },
        },
      ],
    };
    const first = createExecutionIdentity(runId, 'a', 0);
    const lost = createExecutionIdentity(runId, 'b', 0);
    await runs.save({
      runId,
      workflowId: workflow.id,
      workflowSnapshot: workflow,
      status: 'running',
      counts: { total: 2, completed: 1, failed: 0, skipped: 0 },
      createdAt: new Date(Date.now() - 60_000),
      startedAt: new Date('2026-09-24T10:00:00.000Z'),
      events: [
        {
          type: 'step:finished',
          workflowRunId: runId,
          step: workflow.steps[0],
          execution: first,
          result: {
            stepId: 'a',
            execution: first,
            status: StepStatuses.COMPLETED,
            success: true,
            result: { value: 7 },
            pluginResult: { success: true, data: { value: 7 } },
          },
        },
      ],
    });
    for (const [identity, stepId, maxAttempts] of [
      [first, 'a', 1],
      [lost, 'b', 2],
    ] as const) {
      await executions.ensureJob({
        execution: identity,
        runId,
        stepId,
        idempotencyKey: identity.jobId,
        retryPolicy: { maxAttempts, backoffMs: 0 },
      });
      await executions.ensureAttempt(identity);
    }
    await prisma.executionAttempt.update({
      where: { attemptId: first.attemptId },
      data: { status: AttemptStatuses.SUCCEEDED },
    });
    await prisma.executionJob.update({
      where: { jobId: first.jobId },
      data: { status: AttemptStatuses.SUCCEEDED },
    });
    await prisma.executionAttempt.update({
      where: { attemptId: lost.attemptId },
      data: { status: AttemptStatuses.TIMED_OUT },
    });
    await prisma.executionJob.update({
      where: { jobId: lost.jobId },
      data: { status: AttemptStatuses.TIMED_OUT },
    });

    const calls: string[] = [];
    let onEvent: ((event: WorkflowLifecycleEvent) => void | Promise<void>) | undefined;
    const executor = createWorkflowExecutor({
      pluginExecutor: async (_plugin, _config, context) => {
        const stepId = getContext<string>(context, WorkflowContextKeys.stepId)!;
        calls.push(stepId);
        return { success: true, data: { value: 8 } };
      },
      observer: { onEvent: (event) => onEvent?.(event) },
    });
    const engine = {
      onEvent: (handler: typeof onEvent) => {
        onEvent = handler;
      },
      setEmbeddedRunHooks: jest.fn(),
      setBeforeStepExecute: jest.fn(),
      runWorkflow: (id: string, definition: WorkflowDefinition, context: object, options: object) =>
        executor.executeWorkflow(id, definition, context, options),
    } as unknown as EngineService;
    const manager = new RunManagerService(
      engine,
      runs,
      { fanOut: jest.fn() } as unknown as RunStreamService,
      config,
      executions,
      {
        start: jest.fn(async () => undefined),
        stop: jest.fn(),
      } as unknown as ExecutionLeaseService,
      { request: jest.fn() } as never,
    );
    manager.onModuleInit();

    const recovery = new RunRecoveryService(
      { listRecoverableRunIds: async () => [runId] } as unknown as RunRepository,
      new ExecutionRecoveryService(executions),
      manager,
      config,
    );
    await recovery.scan();
    for (let i = 0; i < 100; i++) {
      if ((await runs.findById(runId))?.status === 'finished') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const run = await runs.findById(runId);
    expect(run?.status).toBe('finished');
    expect(run?.startedAt).toEqual(new Date('2026-09-24T10:00:00.000Z'));
    expect(run?.counts.completed).toBe(2);
    expect(run?.result?.results.map((result) => result.stepId)).toEqual(['a', 'b']);
    expect(calls).toEqual(['b']);
    expect(
      await prisma.executionAttempt.findUnique({ where: { attemptId: `${lost.jobId}/attempt-1` } }),
    ).toMatchObject({ attempt: 1, status: AttemptStatuses.SUCCEEDED });
    manager.onModuleDestroy();
  });

  it('does not replay a condition skip and continues its downstream step after restart', async () => {
    runId = randomUUID();
    const workflow: WorkflowDefinition = {
      id: 'recovery-skipped-integration',
      name: 'Recovery with skip',
      steps: [
        { id: 'a', name: 'A', plugin: 'test', config: {} },
        {
          id: 'b',
          name: 'B',
          plugin: 'test',
          config: {},
          dependsOn: ['a'],
          condition: { when: 'enabled', equals: true },
        },
        { id: 'c', name: 'C', plugin: 'test', config: {}, dependsOn: ['b'] },
      ],
    };
    const first = createExecutionIdentity(runId, 'a', 0);
    const skipped = createExecutionIdentity(runId, 'b', 0);
    await runs.save({
      runId,
      workflowId: workflow.id,
      workflowSnapshot: workflow,
      status: 'running',
      counts: { total: 3, completed: 1, failed: 0, skipped: 1 },
      createdAt: new Date(Date.now() - 60_000),
      events: [
        {
          type: 'step:finished',
          workflowRunId: runId,
          step: workflow.steps[0],
          execution: first,
          result: {
            stepId: 'a',
            execution: first,
            status: StepStatuses.COMPLETED,
            success: true,
            result: { value: 7 },
            pluginResult: { success: true, data: { value: 7 } },
          },
        },
        {
          type: 'step:finished',
          workflowRunId: runId,
          step: workflow.steps[1],
          execution: skipped,
          result: {
            stepId: 'b',
            execution: skipped,
            status: StepStatuses.SKIPPED,
            success: true,
            skipReason: SkipReasons.CONDITION_NOT_MET,
            result: { skipped: true, reason: SkipReasons.CONDITION_NOT_MET },
          },
        },
      ],
    });
    for (const [identity, stepId] of [
      [first, 'a'],
      [skipped, 'b'],
    ] as const) {
      await executions.ensureJob({
        execution: identity,
        runId,
        stepId,
        idempotencyKey: identity.jobId,
        retryPolicy: { maxAttempts: 1, backoffMs: 0 },
      });
      await executions.ensureAttempt(identity);
    }
    for (const [identity, status] of [
      [first, AttemptStatuses.SUCCEEDED],
      [skipped, AttemptStatuses.SKIPPED],
    ] as const) {
      await prisma.executionAttempt.update({
        where: { attemptId: identity.attemptId },
        data: { status },
      });
      await prisma.executionJob.update({ where: { jobId: identity.jobId }, data: { status } });
    }

    const calls: string[] = [];
    let onEvent: ((event: WorkflowLifecycleEvent) => void | Promise<void>) | undefined;
    const executor = createWorkflowExecutor({
      pluginExecutor: async (_plugin, _config, context) => {
        calls.push(getContext<string>(context, WorkflowContextKeys.stepId)!);
        return { success: true, data: { value: 8 } };
      },
      observer: { onEvent: (event) => onEvent?.(event) },
    });
    const engine = {
      onEvent: (handler: typeof onEvent) => {
        onEvent = handler;
      },
      setEmbeddedRunHooks: jest.fn(),
      setBeforeStepExecute: jest.fn(),
      runWorkflow: (id: string, definition: WorkflowDefinition, context: object, options: object) =>
        executor.executeWorkflow(id, definition, context, options),
    } as unknown as EngineService;
    const manager = new RunManagerService(
      engine,
      runs,
      { fanOut: jest.fn() } as unknown as RunStreamService,
      config,
      executions,
      {
        start: jest.fn(async () => undefined),
        stop: jest.fn(),
      } as unknown as ExecutionLeaseService,
      { request: jest.fn() } as never,
    );
    manager.onModuleInit();
    const recovery = new RunRecoveryService(
      { listRecoverableRunIds: async () => [runId] } as unknown as RunRepository,
      new ExecutionRecoveryService(executions),
      manager,
      config,
    );
    await recovery.scan();
    for (let i = 0; i < 100; i++) {
      if ((await runs.findById(runId))?.status === 'finished') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const run = await runs.findById(runId);
    expect(run?.status).toBe('finished');
    expect(run?.counts).toEqual({ total: 3, completed: 2, failed: 0, skipped: 1 });
    expect(
      run?.events.filter(
        (event) =>
          event.type === 'step:finished' && (event.step as { id?: string } | undefined)?.id === 'b',
      ),
    ).toHaveLength(1);
    expect(calls).toEqual(['c']);
    expect(
      await prisma.executionAttempt.findUnique({ where: { attemptId: skipped.attemptId } }),
    ).toMatchObject({ status: AttemptStatuses.SKIPPED });
    manager.onModuleDestroy();
  });

  it('resumes a paused Run on explicit control after its original owner is gone', async () => {
    runId = randomUUID();
    const workflow: WorkflowDefinition = {
      id: 'recovery-paused-integration',
      name: 'Recovery after pause',
      steps: [
        { id: 'a', name: 'A', plugin: 'test', config: {} },
        { id: 'b', name: 'B', plugin: 'test', config: {}, dependsOn: ['a'] },
      ],
    };
    const first = createExecutionIdentity(runId, 'a', 0);
    await runs.save({
      runId,
      workflowId: workflow.id,
      workflowSnapshot: workflow,
      status: 'paused',
      counts: { total: 2, completed: 1, failed: 0, skipped: 0 },
      createdAt: new Date(Date.now() - 60_000),
      startedAt: new Date('2026-09-24T10:00:00.000Z'),
      events: [
        {
          type: 'step:finished',
          workflowRunId: runId,
          step: workflow.steps[0],
          execution: first,
          result: {
            stepId: 'a',
            execution: first,
            status: StepStatuses.COMPLETED,
            success: true,
            result: { value: 7 },
            pluginResult: { success: true, data: { value: 7 } },
          },
        },
        { type: 'workflow:paused', workflowRunId: runId, inFlightSteps: [] },
      ],
    });
    await executions.ensureJob({
      execution: first,
      runId,
      stepId: 'a',
      idempotencyKey: first.jobId,
      retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    });
    await executions.ensureAttempt(first);
    await prisma.executionAttempt.update({
      where: { attemptId: first.attemptId },
      data: { status: AttemptStatuses.SUCCEEDED },
    });
    await prisma.executionJob.update({
      where: { jobId: first.jobId },
      data: { status: AttemptStatuses.SUCCEEDED },
    });

    const calls: string[] = [];
    let onEvent: ((event: WorkflowLifecycleEvent) => void | Promise<void>) | undefined;
    const executor = createWorkflowExecutor({
      pluginExecutor: async (_plugin, _config, context) => {
        calls.push(getContext<string>(context, WorkflowContextKeys.stepId)!);
        return { success: true, data: { value: 8 } };
      },
      observer: { onEvent: (event) => onEvent?.(event) },
    });
    const engine = {
      isReady: jest.fn(() => true),
      getRunStatus: jest.fn(() => ({ workflowRunId: runId, status: 'unknown', inFlightSteps: [] })),
      onEvent: (handler: typeof onEvent) => {
        onEvent = handler;
      },
      setEmbeddedRunHooks: jest.fn(),
      setBeforeStepExecute: jest.fn(),
      runWorkflow: (id: string, definition: WorkflowDefinition, context: object, options: object) =>
        executor.executeWorkflow(id, definition, context, options),
    } as unknown as EngineService;
    const controls = new ExecutionControlService(engine, runs, executions, config);
    const manager = new RunManagerService(
      engine,
      runs,
      { fanOut: jest.fn() } as unknown as RunStreamService,
      config,
      executions,
      {
        start: jest.fn(async () => undefined),
        stop: jest.fn(),
      } as unknown as ExecutionLeaseService,
      controls,
    );
    manager.onModuleInit();

    expect(
      await runs.acquireRunLease(
        runId,
        'original-owner',
        'original-token',
        new Date(Date.now() + 60_000),
      ),
    ).toBe(true);
    const result = await controls.request(runId, 'resume');
    expect(result.status).toBe('pending');
    expect(
      await prisma.executionControlCommand.findUnique({
        where: { commandId: result.commandId },
      }),
    ).toMatchObject({ status: 'pending', claimedBy: null, claimedAt: null });
    expect(calls).toEqual([]);
    expect(await runs.releaseRunLease(runId, 'original-token')).toBe(true);
    await controls.drain();
    expect(
      await prisma.executionControlCommand.findUnique({
        where: { commandId: result.commandId },
      }),
    ).toMatchObject({ status: 'applied' });
    for (let i = 0; i < 100; i++) {
      if ((await runs.findById(runId))?.status === 'finished') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const run = await runs.findById(runId);
    expect(run?.status).toBe('finished');
    expect(run?.startedAt).toEqual(new Date('2026-09-24T10:00:00.000Z'));
    expect(run?.counts).toEqual({ total: 2, completed: 2, failed: 0, skipped: 0 });
    expect(calls).toEqual(['b']);
    expect(
      run?.events.filter(
        (event) =>
          event.type === 'step:finished' && (event.step as { id?: string } | undefined)?.id === 'a',
      ),
    ).toHaveLength(1);
    manager.onModuleDestroy();
  });

  it('claims a signalled waiting Attempt with its checkpoint and original identity', async () => {
    runId = randomUUID();
    const workflow: WorkflowDefinition = {
      id: 'recovery-ready-wait',
      name: 'Ready wait recovery',
      steps: [{ id: 'wait', name: 'Wait', plugin: 'test', config: {} }],
    };
    const identity = createExecutionIdentity(runId, 'wait', 0);
    await runs.save({
      runId,
      workflowId: workflow.id,
      workflowSnapshot: workflow,
      status: 'running',
      counts: { total: 1, completed: 0, failed: 0, skipped: 0 },
      createdAt: new Date(Date.now() - 60_000),
      events: [],
    });
    await executions.ensureJob({
      execution: identity,
      runId,
      stepId: 'wait',
      idempotencyKey: identity.jobId,
      retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    });
    await executions.ensureAttempt(identity);
    expect(
      await executions.acquireLease(
        identity.attemptId,
        'old-owner',
        'old-token',
        new Date(Date.now() + 60_000),
      ),
    ).toBe(true);
    expect(
      await executions.transitionAttempt(
        identity.attemptId,
        AttemptStatuses.LEASED,
        AttemptStatuses.RUNNING,
      ),
    ).toBe(true);
    const checkpoint = {
      jobId: identity.jobId,
      sourceAttemptId: identity.attemptId,
      version: 1,
      payload: { cursor: 'page-2' },
      createdAt: new Date().toISOString(),
    };
    expect(
      await executions.registerWait({
        execution: identity,
        leaseToken: 'old-token',
        checkpoint,
        condition: { kind: 'signal', key: 'continue' },
      }),
    ).toBe(true);
    const candidatesBefore = await runs.listRecoverableRunIds(
      new Date(),
      new Date(Date.now() - 5_000),
      50,
    );
    expect(candidatesBefore).not.toContain(runId);
    expect(
      await executions.signalWait(identity.attemptId, 'continue', { approved: true }, new Date()),
    ).toBe(true);
    const candidatesAfter = await runs.listRecoverableRunIds(
      new Date(),
      new Date(Date.now() - 5_000),
      50,
    );
    expect(candidatesAfter).toContain(runId);

    const calls: Array<{ attempt: number; checkpoint: unknown; wakePayload: unknown }> = [];
    let onEvent: ((event: WorkflowLifecycleEvent) => void | Promise<void>) | undefined;
    const executor = createWorkflowExecutor({
      pluginExecutor: async (_plugin, _config, context) => {
        calls.push({
          attempt: (context.execution as { attempt: number }).attempt,
          checkpoint: getContext(context, PluginContextKeys.checkpoint),
          wakePayload: getContext(context, PluginContextKeys.wakePayload),
        });
        return { success: true, data: { resumed: true } };
      },
      observer: { onEvent: (event) => onEvent?.(event) },
    });
    const engine = {
      onEvent: (handler: typeof onEvent) => {
        onEvent = handler;
      },
      setEmbeddedRunHooks: jest.fn(),
      setBeforeStepExecute: jest.fn(),
      runWorkflow: (id: string, definition: WorkflowDefinition, context: object, options: object) =>
        executor.executeWorkflow(id, definition, context, options),
    } as unknown as EngineService;
    const leases = new ExecutionLeaseService(executions, config);
    const manager = new RunManagerService(
      engine,
      runs,
      { fanOut: jest.fn() } as unknown as RunStreamService,
      config,
      executions,
      leases,
      { request: jest.fn() } as never,
    );
    manager.onModuleInit();
    const recovery = new RunRecoveryService(
      { listRecoverableRunIds: async () => [runId] } as unknown as RunRepository,
      new ExecutionRecoveryService(executions),
      manager,
      config,
    );
    await recovery.scan();
    for (let i = 0; i < 100; i++) {
      if ((await runs.findById(runId))?.status === 'finished') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect((await runs.findById(runId))?.status).toBe('finished');
    expect(calls).toEqual([
      {
        attempt: 0,
        checkpoint: { cursor: 'page-2' },
        wakePayload: { approved: true },
      },
    ]);
    expect(
      await prisma.executionAttempt.findUnique({
        where: { attemptId: identity.attemptId },
      }),
    ).toMatchObject({ status: AttemptStatuses.SUCCEEDED });
    expect(await prisma.executionAttempt.count({ where: { jobId: identity.jobId } })).toBe(1);
    leases.onModuleDestroy();
    manager.onModuleDestroy();
  });

  it('persists a plugin timer wait, releases ownership, and resumes when due', async () => {
    const workflow: WorkflowDefinition = {
      id: 'producer-wait',
      name: 'Producer wait',
      steps: [
        { id: 'wait', name: 'Wait', plugin: 'test', config: {}, mayWait: true },
        { id: 'after', name: 'After', plugin: 'test', config: {}, dependsOn: ['wait'] },
      ],
    };
    const calls: string[] = [];
    let onEvent: ((event: WorkflowLifecycleEvent) => void | Promise<void>) | undefined;
    let beforeStep:
      | ((step: WorkflowDefinition['steps'][number], context: never) => Promise<void> | void)
      | undefined;
    let onWait:
      | ((step: never, context: never, checkpoint: never, condition: never) => Promise<void>)
      | undefined;
    const executor = createWorkflowExecutor({
      pluginExecutor: async (_plugin, _config, context) => {
        const stepId = getContext<string>(context, WorkflowContextKeys.stepId)!;
        calls.push(stepId);
        if (stepId === 'wait' && !getContext(context, PluginContextKeys.checkpoint)) {
          return {
            success: true,
            wait: {
              checkpoint: { cursor: 'saved' },
              condition: {
                kind: 'timer' as const,
                wakeAt: new Date(Date.now() + 1_000).toISOString(),
              },
            },
          };
        }
        if (stepId === 'wait') {
          expect(getContext(context, PluginContextKeys.checkpoint)).toEqual({ cursor: 'saved' });
          expect(getContext(context, PluginContextKeys.wakePayload)).toBeUndefined();
        }
        return { success: true, data: { stepId } };
      },
      onStepStart: (step, context) => beforeStep?.(step, context as never),
      onStepWait: (step, context, checkpoint, condition) =>
        onWait!(step as never, context as never, checkpoint as never, condition as never),
      observer: { onEvent: (event) => onEvent?.(event) },
    });
    const engine = {
      validateWorkflow: jest.fn(async () => undefined),
      onEvent: (handler: typeof onEvent) => {
        onEvent = handler;
      },
      setEmbeddedRunHooks: jest.fn(),
      setBeforeStepExecute: (handler: typeof beforeStep) => {
        beforeStep = handler;
      },
      setOnStepWait: (handler: typeof onWait) => {
        onWait = handler;
      },
      runWorkflow: (id: string, definition: WorkflowDefinition, context: object, options: object) =>
        executor.executeWorkflow(id, definition, context, options),
    } as unknown as EngineService;
    const leases = new ExecutionLeaseService(executions, config);
    const manager = new RunManagerService(
      engine,
      runs,
      { fanOut: jest.fn() } as unknown as RunStreamService,
      config,
      executions,
      leases,
      { request: jest.fn() } as never,
    );
    manager.onModuleInit();
    const submitted = await manager.submitRun(workflow);
    runId = submitted.runId;
    for (let i = 0; i < 100; i++) {
      if ((await runs.findById(runId))?.status === 'waiting') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const waitingRun = await runs.findById(runId);
    const identity = createExecutionIdentity(runId, 'wait', 0);
    expect(waitingRun?.status).toBe('waiting');
    expect(waitingRun?.counts.completed).toBe(0);
    expect(waitingRun?.events.filter((event) => event.type === 'step:finished')).toHaveLength(0);
    expect(
      await prisma.executionAttempt.findUnique({ where: { attemptId: identity.attemptId } }),
    ).toMatchObject({ status: AttemptStatuses.WAITING, leaseToken: null });
    expect(await prisma.run.findUnique({ where: { runId } })).toMatchObject({ leaseToken: null });
    expect(calls).toEqual(['wait']);

    await prisma.run.update({
      where: { runId },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });
    expect(await executions.wakeDueTimers(new Date(Date.now() + 2_000))).toBe(1);
    const recovery = new RunRecoveryService(
      { listRecoverableRunIds: async () => [runId] } as unknown as RunRepository,
      new ExecutionRecoveryService(executions),
      manager,
      config,
    );
    await recovery.scan();
    for (let i = 0; i < 100; i++) {
      if ((await runs.findById(runId))?.status === 'finished') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect((await runs.findById(runId))?.status).toBe('finished');
    expect(calls).toEqual(['wait', 'wait', 'after']);
    expect(await prisma.executionAttempt.count({ where: { jobId: identity.jobId } })).toBe(1);
    leases.onModuleDestroy();
    manager.onModuleDestroy();
  });

  it('retries a timed-out plugin wait as a new Attempt without replaying downstream work', async () => {
    const workflow: WorkflowDefinition = {
      id: 'producer-timeout',
      name: 'Producer timeout',
      steps: [
        {
          id: 'wait',
          name: 'Wait',
          plugin: 'test',
          config: {},
          mayWait: true,
          retryPolicy: { maxAttempts: 2, backoffMs: 0 },
        },
        { id: 'after', name: 'After', plugin: 'test', config: {}, dependsOn: ['wait'] },
      ],
    };
    const calls: string[] = [];
    let onEvent: ((event: WorkflowLifecycleEvent) => void | Promise<void>) | undefined;
    let beforeStep:
      | ((step: WorkflowDefinition['steps'][number], context: never) => Promise<void> | void)
      | undefined;
    let onWait:
      | ((step: never, context: never, checkpoint: never, condition: never) => Promise<void>)
      | undefined;
    const executor = createWorkflowExecutor({
      pluginExecutor: async (_plugin, _config, context) => {
        const stepId = getContext<string>(context, WorkflowContextKeys.stepId)!;
        const attempt = (context.execution as { attempt: number }).attempt;
        calls.push(`${stepId}/${attempt}`);
        if (stepId === 'wait' && attempt === 0) {
          return {
            success: true,
            wait: {
              checkpoint: { stage: 'approval' },
              condition: {
                kind: 'signal' as const,
                key: 'approval',
                timeoutAt: new Date(Date.now() + 1_000).toISOString(),
              },
            },
          };
        }
        return { success: true, data: { stepId } };
      },
      onStepStart: (step, context) => beforeStep?.(step, context as never),
      onStepWait: (step, context, checkpoint, condition) =>
        onWait!(step as never, context as never, checkpoint as never, condition as never),
      observer: { onEvent: (event) => onEvent?.(event) },
    });
    const engine = {
      validateWorkflow: jest.fn(async () => undefined),
      onEvent: (handler: typeof onEvent) => {
        onEvent = handler;
      },
      setEmbeddedRunHooks: jest.fn(),
      setBeforeStepExecute: (handler: typeof beforeStep) => {
        beforeStep = handler;
      },
      setOnStepWait: (handler: typeof onWait) => {
        onWait = handler;
      },
      runWorkflow: (id: string, definition: WorkflowDefinition, context: object, options: object) =>
        executor.executeWorkflow(id, definition, context, options),
    } as unknown as EngineService;
    const leases = new ExecutionLeaseService(executions, config);
    const manager = new RunManagerService(
      engine,
      runs,
      { fanOut: jest.fn() } as unknown as RunStreamService,
      config,
      executions,
      leases,
      { request: jest.fn() } as never,
    );
    manager.onModuleInit();
    runId = (await manager.submitRun(workflow)).runId;
    for (let i = 0; i < 100; i++) {
      if ((await runs.findById(runId))?.status === 'waiting') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect((await runs.findById(runId))?.status).toBe('waiting');
    await prisma.run.update({
      where: { runId },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });
    expect(await executions.expireWaits(new Date(Date.now() + 2_000))).toBe(1);
    const recovery = new RunRecoveryService(
      { listRecoverableRunIds: async () => [runId] } as unknown as RunRepository,
      new ExecutionRecoveryService(executions),
      manager,
      config,
    );
    await recovery.scan();
    for (let i = 0; i < 100; i++) {
      if ((await runs.findById(runId))?.status === 'finished') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect((await runs.findById(runId))?.status).toBe('finished');
    expect(calls).toEqual(['wait/0', 'wait/1', 'after/0']);
    expect(
      await prisma.executionAttempt.findMany({
        where: { jobId: createExecutionIdentity(runId, 'wait', 0).jobId },
        orderBy: { attempt: 'asc' },
        select: { status: true },
      }),
    ).toEqual([{ status: AttemptStatuses.TIMED_OUT }, { status: AttemptStatuses.SUCCEEDED }]);
    leases.onModuleDestroy();
    manager.onModuleDestroy();
  });
});
