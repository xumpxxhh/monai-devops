import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { createWorkflowExecutor, type ExecutionIdentity } from '@monai-devops/core-engine';
import type { ExecutionRepository } from './execution.repository.js';
import { ExecutionLeaseService } from './execution-lease.service.js';

describe('ExecutionLeaseService', () => {
  it('acquires a lease, enters running, and stops heartbeats on completion', async () => {
    const repository = {
      acquireLease: jest.fn(
        async (_attemptId: string, _owner: string, _token: string, _expires: Date) => true,
      ),
      startLeasedAttempt: jest.fn(async () => true),
      heartbeat: jest.fn(async () => true),
    };
    const config = {
      get: jest.fn((key: string, fallback: unknown) =>
        key === 'EXECUTION_LEASE_TTL_MS' ? 3_000 : fallback,
      ),
    };
    const service = new ExecutionLeaseService(
      repository as unknown as ExecutionRepository,
      config as unknown as ConfigService,
    );
    const execution = { jobId: 'run/s1', attemptId: 'run/s1/attempt-0', attempt: 0 };

    await service.start(execution);

    expect(repository.acquireLease).toHaveBeenCalledWith(
      execution.attemptId,
      expect.stringContaining('server-'),
      expect.any(String),
      expect.any(Date),
    );
    expect(repository.startLeasedAttempt).toHaveBeenCalledWith(
      execution.attemptId,
      repository.acquireLease.mock.calls[0]![2],
    );
    expect(service.has(execution.attemptId)).toBe(true);

    service.stop(execution.attemptId);
    expect(service.has(execution.attemptId)).toBe(false);
  });

  it('rejects execution when the lease cannot be acquired', async () => {
    const repository = { acquireLease: jest.fn(async () => false) };
    const config = { get: jest.fn((_key: string, fallback: unknown) => fallback) };
    const service = new ExecutionLeaseService(
      repository as unknown as ExecutionRepository,
      config as unknown as ConfigService,
    );

    await expect(service.start({ jobId: 'j', attemptId: 'a', attempt: 0 })).rejects.toThrow(
      'lease unavailable',
    );
  });

  it('does not activate a lease when the token-fenced start loses the race', async () => {
    const repository = {
      acquireLease: jest.fn(async () => true),
      startLeasedAttempt: jest.fn(async () => false),
    };
    const service = new ExecutionLeaseService(
      repository as unknown as ExecutionRepository,
      { get: jest.fn((_key: string, fallback: unknown) => fallback) } as unknown as ConfigService,
    );
    const execution = { jobId: 'run/step', attemptId: 'run/step/attempt-0', attempt: 0 };
    await expect(service.start(execution)).rejects.toThrow('could not enter running state');
    expect(service.has(execution.attemptId)).toBe(false);
  });

  it('registers a wait under the active lease token and stops heartbeats', async () => {
    const repository = {
      acquireLease: jest.fn(
        async (_attemptId: string, _owner: string, _token: string, _expires: Date) => true,
      ),
      startLeasedAttempt: jest.fn(async () => true),
      registerWait: jest.fn(async () => true),
    };
    const service = new ExecutionLeaseService(
      repository as unknown as ExecutionRepository,
      { get: jest.fn((_key: string, fallback: unknown) => fallback) } as unknown as ConfigService,
    );
    const execution = { jobId: 'run/step', attemptId: 'run/step/attempt-0', attempt: 0 };
    const checkpoint = {
      jobId: execution.jobId,
      sourceAttemptId: execution.attemptId,
      version: 1,
      payload: { cursor: 1 },
      createdAt: new Date().toISOString(),
    };
    const condition = { kind: 'signal' as const, key: 'continue' };
    await service.start(execution);
    const leaseToken = repository.acquireLease.mock.calls[0]![2];

    await service.registerWait(execution, checkpoint, condition);

    expect(repository.registerWait).toHaveBeenCalledWith({
      execution,
      leaseToken,
      checkpoint,
      condition,
    });
    expect(service.has(execution.attemptId)).toBe(false);
  });

  it('confirms an already-persisted worker wait without acquiring a local lease', async () => {
    const repository = {
      confirmRegisteredWorkerWait: jest.fn(async () => true),
      registerWait: jest.fn(async () => false),
    };
    const service = new ExecutionLeaseService(
      repository as unknown as ExecutionRepository,
      { get: jest.fn((_key: string, fallback: unknown) => fallback) } as unknown as ConfigService,
    );
    const execution = { jobId: 'run/step', attemptId: 'run/step/attempt-0', attempt: 0 };
    const checkpoint = {
      jobId: execution.jobId,
      sourceAttemptId: execution.attemptId,
      version: 1,
      payload: { cursor: 1 },
      createdAt: new Date().toISOString(),
    };
    const condition = { kind: 'signal' as const, key: 'continue' };
    await service.registerWait(execution, checkpoint, condition);
    expect(repository.confirmRegisteredWorkerWait).toHaveBeenCalledWith(
      execution,
      checkpoint,
      condition,
    );
    expect(repository.registerWait).not.toHaveBeenCalled();
  });

  it('rejects a wait without a local lease or matching persisted worker receipt', async () => {
    const repository = { confirmRegisteredWorkerWait: jest.fn(async () => false) };
    const service = new ExecutionLeaseService(
      repository as unknown as ExecutionRepository,
      { get: jest.fn((_key: string, fallback: unknown) => fallback) } as unknown as ConfigService,
    );
    const execution = { jobId: 'run/step', attemptId: 'run/step/attempt-0', attempt: 0 };
    await expect(
      service.registerWait(
        execution,
        {
          jobId: execution.jobId,
          sourceAttemptId: execution.attemptId,
          version: 1,
          payload: {},
          createdAt: new Date().toISOString(),
        },
        { kind: 'signal', key: 'continue' },
      ),
    ).rejects.toThrow('cannot enter waiting');
  });

  it('waits for the durable worker receipt before returning it to the caller', async () => {
    const terminal = { kind: 'complete' as const, result: { success: true, data: { id: 1 } } };
    const repository = {
      readWorkerTerminal: jest.fn(async () =>
        repository.readWorkerTerminal.mock.calls.length === 1 ? undefined : terminal,
      ),
    };
    const service = new ExecutionLeaseService(
      repository as unknown as ExecutionRepository,
      { get: jest.fn((_key: string, fallback: unknown) => fallback) } as unknown as ConfigService,
    );
    const execution = { jobId: 'run/step', attemptId: 'run/step/attempt-0', attempt: 0 };
    await expect(
      service.awaitWorkerTerminal(execution, new AbortController().signal, 1),
    ).resolves.toEqual(terminal);
    expect(repository.readWorkerTerminal).toHaveBeenCalledTimes(2);
  });

  it('stops waiting promptly when the owning execution is aborted', async () => {
    const repository = { readWorkerTerminal: jest.fn(async () => undefined) };
    const service = new ExecutionLeaseService(
      repository as unknown as ExecutionRepository,
      { get: jest.fn((_key: string, fallback: unknown) => fallback) } as unknown as ConfigService,
    );
    const controller = new AbortController();
    const execution = { jobId: 'run/step', attemptId: 'run/step/attempt-0', attempt: 0 };
    const waiting = service.awaitWorkerTerminal(execution, controller.signal, 10_000);
    controller.abort();
    await expect(waiting).rejects.toThrow('Worker result wait aborted');
    expect(repository.readWorkerTerminal).toHaveBeenCalledTimes(1);
  });

  it('hands a persisted worker completion back to the running DAG adapter', async () => {
    const repository = {
      readWorkerTerminal: jest.fn(async () => ({
        kind: 'complete' as const,
        result: { success: true, data: { remote: true } },
      })),
    };
    const service = new ExecutionLeaseService(
      repository as unknown as ExecutionRepository,
      { get: jest.fn((_key: string, fallback: unknown) => fallback) } as unknown as ConfigService,
    );
    const executor = createWorkflowExecutor({
      pluginAdapter: {
        kind: 'remote',
        execute: async (_name, _config, context) => {
          if (!context.execution) throw new Error('Execution identity missing');
          const receipt = await service.awaitWorkerTerminal(
            context.execution as ExecutionIdentity,
            new AbortController().signal,
          );
          return receipt.result;
        },
      },
    });
    const result = await executor.executeWorkflow('remote-receipt-run', {
      id: 'remote-receipt-workflow',
      name: 'Remote receipt workflow',
      steps: [{ id: 'step', name: 'Step', plugin: 'remote-plugin', config: {} }],
    });
    expect(result.success).toBe(true);
    expect(result.results[0]?.pluginResult?.data).toEqual({ remote: true });
    expect(repository.readWorkerTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'remote-receipt-run/step', attempt: 0 }),
    );
  });
});
