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

  function createSubject(remoteEnabled = false, environment = 'development') {
    const repository = {
      ensureJob: jest.fn(async () => undefined),
      ensureAttempt: jest.fn(async () => undefined),
      transitionAttempt: jest.fn(async (_attemptId: string, _from: string) => true),
      setJobStatus: jest.fn(async () => undefined),
      registerWorkerDispatch: jest.fn(async () => true),
    };
    const runRepository = { heartbeatRunLease: jest.fn(async () => true) };
    const leases = {
      start: jest.fn(async () => undefined),
      stop: jest.fn(),
      awaitWorkerTerminal: jest.fn(async () => ({ kind: 'complete', result: { success: true } })),
    };
    const engine = {
      cancelRun: jest.fn(async () => undefined),
      getPlugin: jest.fn(() => ({ version: '1.0.0' })),
    };
    const service = new RunManagerService(
      engine as unknown as EngineService,
      runRepository as unknown as RunRepository,
      {} as RunStreamService,
      {
        get: jest.fn((key: string) => {
          if (key === 'EXECUTOR_REMOTE_TEST_ENABLED') return remoteEnabled;
          if (key === 'EXECUTOR_WORKER_HTTP_TOKEN') return 'x'.repeat(32);
          if (key === 'APP_ENV') return environment;
          return undefined;
        }),
      } as unknown as ConfigService,
      repository as unknown as ExecutionRepository,
      leases as unknown as ExecutionLeaseService,
      { request: jest.fn() } as never,
    );
    (
      service as unknown as {
        runLeases: Map<string, { token: string; timer: ReturnType<typeof setInterval> }>;
      }
    ).runLeases.set('run-1', {
      token: 'run-token',
      timer: 0 as unknown as ReturnType<typeof setInterval>,
    });
    const project = (
      service as unknown as {
        projectExecutionState(event: WorkflowLifecycleEvent, runId: string): Promise<void>;
      }
    ).projectExecutionState.bind(service);
    return { service, project, repository, leases, runRepository, engine };
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
      getRecoveryState: jest.fn(async () => ({ present: false })),
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
    expect(runRepository.getRecoveryState).toHaveBeenCalledWith('run-1');
    expect(executionRepository.listJobsForRun).toHaveBeenCalledWith('run-1');
  });

  it('acquires the durable lease before a managed step is allowed to execute', async () => {
    const { service, repository, leases, runRepository } = createSubject();
    (service as unknown as { managedRunIds: Set<string> }).managedRunIds.add('run-1');
    (service as unknown as { fencedRunIds: Set<string> }).fencedRunIds.add('run-1');
    const authorize = (
      service as unknown as {
        authorizeStepExecution(
          candidate: typeof step,
          runId: unknown,
          identity: typeof execution,
        ): Promise<void>;
      }
    ).authorizeStepExecution.bind(service);

    await authorize(step, 'run-1', execution);

    expect(repository.ensureAttempt).toHaveBeenCalledWith(execution);
    expect(runRepository.heartbeatRunLease).toHaveBeenCalledWith(
      'run-1',
      'run-token',
      expect.any(Date),
    );
    expect(leases.start).toHaveBeenCalledWith(execution);
    expect(repository.setJobStatus).toHaveBeenCalledWith(execution.jobId, AttemptStatuses.RUNNING);
  });

  it('does not start an Attempt after losing Run ownership', async () => {
    const { service, repository, leases, runRepository } = createSubject();
    (service as unknown as { managedRunIds: Set<string> }).managedRunIds.add('run-1');
    (service as unknown as { fencedRunIds: Set<string> }).fencedRunIds.add('run-1');
    runRepository.heartbeatRunLease.mockImplementation(async () => false);
    await expect(
      (
        service as unknown as {
          authorizeStepExecution(
            candidate: typeof step,
            runId: string,
            identity: typeof execution,
          ): Promise<void>;
        }
      ).authorizeStepExecution(step, 'run-1', execution),
    ).rejects.toThrow(/Run lease unavailable/);
    expect(repository.ensureAttempt).not.toHaveBeenCalled();
    expect(leases.start).not.toHaveBeenCalled();
    expect((service as unknown as { managedRunIds: Set<string> }).managedRunIds.has('run-1')).toBe(
      false,
    );
    expect((service as unknown as { fencedRunIds: Set<string> }).fencedRunIds.has('run-1')).toBe(
      true,
    );
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

  it('keeps the experimental remote test Attempt queued until a worker claims it', async () => {
    const { service, project, repository, leases } = createSubject(true);
    const remoteStep = {
      id: 'step-1',
      name: 'Remote test',
      plugin: 'test-plugin',
      config: { type: 'unit' },
    };
    (service as unknown as { fencedRunIds: Set<string> }).fencedRunIds.add('run-1');
    (service as unknown as { managedRunIds: Set<string> }).managedRunIds.add('run-1');
    await (
      service as unknown as {
        authorizeStepExecution(
          step: typeof remoteStep,
          runId: string,
          identity: typeof execution,
        ): Promise<void>;
      }
    ).authorizeStepExecution(remoteStep, 'run-1', execution);
    await project(
      {
        type: 'step:start',
        workflowRunId: 'run-1',
        meta: { workflowId: 'workflow-1' },
        step: remoteStep,
        execution,
      },
      'run-1',
    );
    expect(repository.ensureAttempt).toHaveBeenCalledWith(execution);
    expect(leases.start).not.toHaveBeenCalled();
    expect(repository.setJobStatus).not.toHaveBeenCalledWith(
      execution.jobId,
      AttemptStatuses.RUNNING,
    );
  });

  it('keeps production on the local execution path even when the remote flag is set', async () => {
    const { service, leases } = createSubject(true, 'production');
    (service as unknown as { fencedRunIds: Set<string> }).fencedRunIds.add('run-1');
    const remoteStep = {
      id: 'step-1',
      name: 'Remote test',
      plugin: 'test-plugin',
      config: { type: 'unit' },
    };
    await (
      service as unknown as {
        authorizeStepExecution(
          step: typeof remoteStep,
          runId: string,
          identity: typeof execution,
        ): Promise<void>;
      }
    ).authorizeStepExecution(remoteStep, 'run-1', execution);
    expect(leases.start).toHaveBeenCalledWith(execution);
  });

  it('registers only sanitized test input and returns the durable worker result', async () => {
    const { service, repository, leases } = createSubject(true);
    (service as unknown as { fencedRunIds: Set<string> }).fencedRunIds.add('run-1');
    (service as unknown as { managedRunIds: Set<string> }).managedRunIds.add('run-1');
    const signal = new AbortController().signal;
    const result = await (
      service as unknown as {
        executeRemoteTestPlugin(name: string, config: object, context: object): Promise<unknown>;
      }
    ).executeRemoteTestPlugin(
      'test-plugin',
      { type: 'unit', extra: 'not-forwarded' },
      {
        runId: 'run-1',
        workflowId: 'workflow-1',
        stepId: 'step-1',
        execution,
        signal,
      },
    );
    expect(repository.registerWorkerDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        execution,
        input: { config: { type: 'unit' }, context: {} },
        requiredCapabilities: [],
      }),
      'run-token',
    );
    expect(leases.awaitWorkerTerminal).toHaveBeenCalledWith(
      execution,
      'run-1',
      'run-token',
      signal,
    );
    expect(result).toEqual({ success: true });
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
