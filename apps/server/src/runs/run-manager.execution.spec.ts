import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import {
  AttemptStatuses,
  SkipReasons,
  StepStatuses,
  type WorkflowLifecycleEvent,
} from '@monai-devops/core-engine';
import type { EngineService } from '../engine/engine.service.js';
import type { ExecutionLeaseService } from '../execution/execution-lease.service.js';
import type { ExecutionRepository } from '../execution/execution.repository.js';
import { RunManagerService } from './run-manager.service.js';
import type { RunStreamService } from './run-stream.service.js';
import type { RunRepository } from './runs.repository.js';

describe('RunManagerService execution projection', () => {
  const execution = { jobId: 'run-1/step-1', attemptId: 'run-1/step-1/attempt-0', attempt: 0 };
  const step = { id: 'step-1', name: 'Step 1', plugin: 'print', config: {} };

  function createSubject() {
    const repository = {
      ensureJob: jest.fn(async () => undefined),
      ensureAttempt: jest.fn(async () => undefined),
      transitionAttempt: jest.fn(async (_attemptId: string, _from: string) => true),
      setJobStatus: jest.fn(async () => undefined),
    };
    const leases = { start: jest.fn(async () => undefined), stop: jest.fn() };
    const service = new RunManagerService(
      {} as EngineService,
      {} as RunRepository,
      {} as RunStreamService,
      { get: jest.fn() } as unknown as ConfigService,
      repository as unknown as ExecutionRepository,
      leases as unknown as ExecutionLeaseService,
      { request: jest.fn() } as never,
    );
    const project = (
      service as unknown as {
        projectExecutionState(event: WorkflowLifecycleEvent, runId: string): Promise<void>;
      }
    ).projectExecutionState.bind(service);
    return { service, project, repository, leases };
  }

  it('loads a recovery snapshot from the Run and Job repositories without executing it', async () => {
    const runRepository = {
      findById: jest.fn(async () => ({
        runId: 'run-1',
        workflowId: 'workflow-1',
        workflowSnapshot: { id: 'workflow-1', name: 'Recovery', steps: [] },
        status: 'queued',
        counts: { total: 0, completed: 0, failed: 0, skipped: 0 },
        createdAt: new Date(),
        events: [],
      })),
    };
    const executionRepository = { listJobsForRun: jest.fn(async () => []) };
    const service = new RunManagerService(
      {} as EngineService,
      runRepository as unknown as RunRepository,
      {} as RunStreamService,
      { get: jest.fn() } as unknown as ConfigService,
      executionRepository as unknown as ExecutionRepository,
      {} as ExecutionLeaseService,
      { request: jest.fn() } as never,
    );

    expect(await service.loadRecoverySnapshot('run-1')).toEqual({
      completedResults: [],
      nextAttemptByStep: {},
    });
    expect(runRepository.findById).toHaveBeenCalledWith('run-1');
    expect(executionRepository.listJobsForRun).toHaveBeenCalledWith('run-1');
  });

  it('acquires the durable lease before a managed step is allowed to execute', async () => {
    const { service, repository, leases } = createSubject();
    (service as unknown as { managedRunIds: Set<string> }).managedRunIds.add('run-1');
    const authorize = (
      service as unknown as {
        authorizeStepExecution(
          stepId: string,
          retryPolicy: undefined,
          runId: unknown,
          identity: typeof execution,
        ): Promise<void>;
      }
    ).authorizeStepExecution.bind(service);

    await authorize(step.id, undefined, 'run-1', execution);

    expect(repository.ensureAttempt).toHaveBeenCalledWith(execution);
    expect(leases.start).toHaveBeenCalledWith(execution);
    expect(repository.setJobStatus).toHaveBeenCalledWith(execution.jobId, AttemptStatuses.RUNNING);
  });

  it('leases a started attempt and persists the running job state', async () => {
    const { project, repository, leases } = createSubject();
    await project(
      {
        type: 'step:start',
        workflowRunId: 'run-1',
        meta: { workflowId: 'workflow-1' },
        step,
        execution,
      },
      'run-1',
    );

    expect(repository.ensureJob).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', idempotencyKey: execution.jobId }),
    );
    expect(leases.start).toHaveBeenCalledWith(execution);
    expect(repository.setJobStatus).toHaveBeenCalledWith(execution.jobId, AttemptStatuses.RUNNING);
  });

  it('persists a never-started condition skip as a terminal skipped attempt', async () => {
    const { project, repository, leases } = createSubject();
    repository.transitionAttempt.mockImplementation(
      async (_attemptId: string, from: string) => from === AttemptStatuses.QUEUED,
    );
    await project(
      {
        type: 'step:finished',
        workflowRunId: 'run-1',
        meta: { workflowId: 'workflow-1' },
        step,
        execution,
        result: {
          stepId: step.id,
          execution,
          status: StepStatuses.SKIPPED,
          success: false,
          skipReason: SkipReasons.CONDITION_NOT_MET,
        },
      },
      'run-1',
    );

    expect(leases.stop).toHaveBeenCalledWith(execution.attemptId);
    expect(repository.transitionAttempt).toHaveBeenLastCalledWith(
      execution.attemptId,
      AttemptStatuses.QUEUED,
      AttemptStatuses.SKIPPED,
      SkipReasons.CONDITION_NOT_MET,
    );
    expect(repository.setJobStatus).toHaveBeenCalledWith(execution.jobId, AttemptStatuses.SKIPPED);
  });

  it('keeps the job queued after a retryable non-final attempt fails', async () => {
    const { project, repository } = createSubject();
    const retryingStep = { ...step, retryPolicy: { maxAttempts: 2, backoffMs: 0 } };
    await project(
      {
        type: 'step:finished',
        workflowRunId: 'run-1',
        meta: { workflowId: 'workflow-1' },
        step: retryingStep,
        execution,
        result: {
          stepId: step.id,
          execution,
          status: StepStatuses.FAILED,
          success: false,
          reason: { code: 'internal', category: 'internal', retryable: true },
        },
      },
      'run-1',
    );

    expect(repository.setJobStatus).toHaveBeenLastCalledWith(
      execution.jobId,
      AttemptStatuses.QUEUED,
    );
  });
});
