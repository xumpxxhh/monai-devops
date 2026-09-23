import { jest } from '@jest/globals';
import { AttemptStatuses } from '@monai-devops/core-engine';
import type { ExecutionRepository } from './execution.repository.js';
import { ExecutionRecoveryService } from './execution-recovery.service.js';

describe('ExecutionRecoveryService', () => {
  it('marks expired owned attempts as timed out while preserving waiting attempts', async () => {
    const repository = {
      listRecoverable: jest.fn(async () => [
        { attemptId: 'expired', jobId: 'job-1', attempt: 0, status: AttemptStatuses.RUNNING },
        { attemptId: 'waiting', jobId: 'job-2', attempt: 0, status: AttemptStatuses.WAITING },
      ]),
      transitionAttempt: jest.fn(async () => true),
      setJobStatus: jest.fn(async () => undefined),
    };
    const service = new ExecutionRecoveryService(repository as unknown as ExecutionRepository);

    await service.onModuleInit();

    expect(repository.transitionAttempt).toHaveBeenCalledTimes(1);
    expect(repository.transitionAttempt).toHaveBeenCalledWith(
      'expired',
      AttemptStatuses.RUNNING,
      AttemptStatuses.TIMED_OUT,
      expect.objectContaining({ code: 'executor_lease_expired' }),
    );
    expect(repository.setJobStatus).toHaveBeenCalledWith('job-1', AttemptStatuses.TIMED_OUT);
  });
});
