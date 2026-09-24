import { jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import type { ExecutionRecoveryService } from '../execution/execution-recovery.service.js';
import type { RunManagerService } from './run-manager.service.js';
import { RunRecoveryService } from './run-recovery.service.js';
import type { RunRepository } from './runs.repository.js';

describe('RunRecoveryService', () => {
  it('times out lost Attempts before dispatching a recoverable Run', async () => {
    const order: string[] = [];
    const attempts = {
      scanExpiredAttempts: jest.fn(async () => {
        order.push('attempts');
      }),
    };
    const runs = {
      listRecoverableRunIds: jest.fn(async () => {
        order.push('list-runs');
        return ['run-1'];
      }),
    };
    const manager = {
      resumePersistedRun: jest.fn(async () => {
        order.push('resume');
        return true;
      }),
    };
    const config = { get: jest.fn((_key: string, fallback: number) => fallback) };
    const service = new RunRecoveryService(
      runs as unknown as RunRepository,
      attempts as unknown as ExecutionRecoveryService,
      manager as unknown as RunManagerService,
      config as unknown as ConfigService,
    );

    await service.scan();

    expect(order).toEqual(['attempts', 'list-runs', 'resume']);
    expect(runs.listRecoverableRunIds).toHaveBeenCalledWith(
      expect.any(Date),
      expect.any(Date),
      50,
      [],
    );
  });

  it('leaves unready Runs untouched and continues with other candidates', async () => {
    const runs = { listRecoverableRunIds: jest.fn(async () => ['blocked', 'ready']) };
    const attempts = { scanExpiredAttempts: jest.fn(async () => undefined) };
    const manager = {
      resumePersistedRun: jest.fn(async (runId: string) => {
        if (runId === 'blocked') throw new Error('checkpoint unavailable');
        return true;
      }),
    };
    const service = new RunRecoveryService(
      runs as unknown as RunRepository,
      attempts as unknown as ExecutionRecoveryService,
      manager as unknown as RunManagerService,
      { get: jest.fn((_key: string, fallback: number) => fallback) } as unknown as ConfigService,
    );

    await service.scan();
    expect(manager.resumePersistedRun).toHaveBeenCalledTimes(2);
    expect(manager.resumePersistedRun).toHaveBeenCalledWith('ready');
    await service.scan();
    expect(runs.listRecoverableRunIds).toHaveBeenLastCalledWith(
      expect.any(Date),
      expect.any(Date),
      50,
      ['blocked'],
    );
  });
});
