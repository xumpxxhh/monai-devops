import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { AttemptStatuses } from '@monai-devops/core-engine';
import type { ExecutionRepository } from './execution.repository.js';
import { ExecutionLeaseService } from './execution-lease.service.js';

describe('ExecutionLeaseService', () => {
  it('acquires a lease, enters running, and stops heartbeats on completion', async () => {
    const repository = {
      acquireLease: jest.fn(async () => true),
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
});
