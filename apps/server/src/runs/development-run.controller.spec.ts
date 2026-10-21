import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import type { ExecutionRepository } from '../execution/execution.repository.js';
import { ExecutionWakeService } from '../execution/execution-wake.service.js';
import { DevelopmentRunController } from './development-run.controller.js';
import type { RunRepository } from './runs.repository.js';

describe('DevelopmentRunController', () => {
  const run = { runId: 'run-1', metadata: { tenantId: 'development-default' } };
  const attempt = {
    attemptId: 'attempt-1',
    stepId: 'step-1',
    status: 'waiting',
    wakeKey: 'approved',
  };
  const runs = { findById: jest.fn(async () => run) };
  const executions = {
    listDevelopmentAttemptsForRun: jest.fn(async () => [attempt]),
    readDevelopmentRunObject: jest.fn(async () => ({
      ref: { objectId: 'object-1', kind: 'result' },
      content: Buffer.from('hello'),
    })),
  };
  const wake = { signal: jest.fn(async () => true) };
  const controller = (appEnv = 'local-dev') =>
    new DevelopmentRunController(
      { get: jest.fn(() => appEnv) } as unknown as ConfigService,
      runs as unknown as RunRepository,
      executions as unknown as ExecutionRepository,
      wake as unknown as ExecutionWakeService,
    );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns bound attempts and object content in local development', async () => {
    expect(await controller().listAttempts('run-1')).toEqual({
      runId: 'run-1',
      attempts: [attempt],
    });
    expect(await controller().readObject('run-1', 'object-1')).toEqual({
      objectRef: { objectId: 'object-1', kind: 'result' },
      bodyBase64: 'aGVsbG8=',
    });
    expect(executions.readDevelopmentRunObject).toHaveBeenCalledWith('run-1', 'object-1');
  });

  it('accepts a signal only for a waiting Attempt bound to the Run', async () => {
    expect(
      await controller().signalWait('run-1', 'attempt-1', {
        key: 'approved',
        payload: { ok: true },
      }),
    ).toEqual({
      runId: 'run-1',
      attemptId: 'attempt-1',
      accepted: true,
    });
    expect(wake.signal).toHaveBeenCalledWith('attempt-1', 'approved', { ok: true });
    await expect(
      controller().signalWait('run-1', 'another', { key: 'approved' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(wake.signal).toHaveBeenCalledTimes(1);
  });

  it('keeps the endpoint closed outside local-dev', async () => {
    await expect(controller('production').listAttempts('run-1')).rejects.toMatchObject({
      status: 404,
    });
    expect(runs.findById).not.toHaveBeenCalled();
  });

  it('does not expose another tenant Run through the development viewer', async () => {
    runs.findById.mockImplementationOnce(async () => ({
      ...run,
      metadata: { tenantId: 'another-tenant' },
    }));
    await expect(controller().listAttempts('run-1')).rejects.toMatchObject({ status: 404 });
    expect(executions.listDevelopmentAttemptsForRun).not.toHaveBeenCalled();
  });
});
