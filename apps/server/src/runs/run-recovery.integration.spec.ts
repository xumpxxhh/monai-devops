import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import { getContext } from '@monai-devops/plugin-sdk';
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
import type { ExecutionLeaseService } from '../execution/execution-lease.service.js';
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
});
