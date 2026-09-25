import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { AttemptStatuses } from '@monai-devops/core-engine';
import type { ExecutionRepository } from './execution.repository.js';
import { ExecutionLeaseService } from './execution-lease.service.js';

describe('ExecutionLeaseService', () => {
  it('acquires a lease, enters running, and stops heartbeats on completion', async () => {
    const repository = {
      acquireLease: jest.fn(
        async (_attemptId: string, _owner: string, _token: string, _expires: Date) => true,
      ),
      transitionAttempt: jest.fn(async () => true),
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
    expect(repository.transitionAttempt).toHaveBeenCalledWith(
      execution.attemptId,
      AttemptStatuses.LEASED,
      AttemptStatuses.RUNNING,
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

  it('registers a wait under the active lease token and stops heartbeats', async () => {
    const repository = {
      acquireLease: jest.fn(
        async (_attemptId: string, _owner: string, _token: string, _expires: Date) => true,
      ),
      transitionAttempt: jest.fn(async () => true),
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
});
