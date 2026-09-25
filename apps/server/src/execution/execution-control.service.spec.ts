import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import type { EngineService } from '../engine/engine.service.js';
import type { RunRecord, RunRepository } from '../runs/runs.repository.js';
import { RunRecoveryNotReadyError } from '../runs/run-recovery-snapshot.js';
import { ExecutionControlService } from './execution-control.service.js';
import type { ExecutionControlCommand, ExecutionRepository } from './execution.repository.js';

describe('ExecutionControlService', () => {
  const run: RunRecord = {
    runId: 'run-1',
    workflowId: 'workflow-1',
    workflowSnapshot: { id: 'workflow-1', name: 'Workflow 1', steps: [] },
    status: 'running',
    counts: { total: 0, completed: 0, failed: 0, skipped: 0 },
    createdAt: new Date(),
    events: [],
  };

  function createSubject(options: { engineStatus?: string; runStatus?: RunRecord['status'] } = {}) {
    const commandRows: ExecutionControlCommand[] = [];
    const engine = {
      isReady: jest.fn(() => true),
      getRunStatus: jest.fn(() => ({
        workflowRunId: run.runId,
        status: options.engineStatus ?? 'running',
        inFlightSteps: [],
      })),
      pauseRun: jest.fn(async () => ({
        workflowRunId: run.runId,
        action: 'pause' as const,
        previousStatus: 'running' as const,
        currentStatus: 'paused' as const,
        inFlightSteps: [],
      })),
      resumeRun: jest.fn(),
      cancelRun: jest.fn(),
    };
    const runs = {
      findById: jest.fn(async () => ({ ...run, status: options.runStatus ?? run.status })),
      update: jest.fn(async (_runId: string, patch: Partial<RunRecord>) => ({ ...run, ...patch })),
    };
    const executions = {
      enqueueControl: jest.fn(async (command: ExecutionControlCommand) => {
        commandRows.push(command);
      }),
      listClaimableControls: jest.fn(async () => commandRows),
      claimControl: jest.fn(async () => true),
      releaseControlClaim: jest.fn(async () => true),
      completeControl: jest.fn(async () => true),
    };
    const config = {
      get: jest.fn((key: string, fallback: unknown) =>
        key === 'EXECUTOR_ID' ? 'executor-1' : fallback,
      ),
    };
    const service = new ExecutionControlService(
      engine as unknown as EngineService,
      runs as unknown as RunRepository,
      executions as unknown as ExecutionRepository,
      config as unknown as ConfigService,
    );
    return { service, engine, runs, executions, commandRows };
  }

  it('persists and immediately applies a command owned by this executor', async () => {
    const { service, engine, runs, executions } = createSubject();

    const result = await service.request('run-1', 'pause', { waitInFlight: false });

    expect(result.status).toBe('applied');
    expect(engine.pauseRun).toHaveBeenCalledWith('run-1', {
      waitInFlight: false,
      abortInFlight: false,
    });
    expect(runs.update).toHaveBeenCalledWith('run-1', { status: 'paused' });
    expect(executions.completeControl).toHaveBeenCalledWith(
      result.commandId,
      'executor-1',
      'applied',
    );
  });

  it('leaves a command pending when the run belongs to another process', async () => {
    const { service, engine, executions } = createSubject({ engineStatus: 'unknown' });

    const result = await service.request('run-1', 'pause');

    expect(result.status).toBe('pending');
    expect(engine.pauseRun).not.toHaveBeenCalled();
    expect(executions.claimControl).not.toHaveBeenCalled();
  });

  it('durably cancels a queued run even when no process owns it yet', async () => {
    const { service, runs, executions } = createSubject({
      engineStatus: 'unknown',
      runStatus: 'queued',
    });

    const result = await service.request('run-1', 'cancel', { mode: 'hard' });

    expect(result.status).toBe('applied');
    expect(runs.update).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ status: 'cancelled', cancelled: 'hard' }),
    );
    expect(executions.completeControl).toHaveBeenCalledWith(
      result.commandId,
      'executor-1',
      'applied',
    );
  });

  it('consumes commands inserted by a different server through the polling path', async () => {
    const { service, engine, executions, commandRows } = createSubject();
    commandRows.push({
      commandId: 'remote-command',
      runId: 'run-1',
      type: 'pause',
      payload: {},
      status: 'pending',
      requestedAt: new Date(),
    });

    await service.drain();

    expect(engine.pauseRun).toHaveBeenCalledWith('run-1', {
      waitInFlight: true,
      abortInFlight: false,
    });
    expect(executions.completeControl).toHaveBeenCalledWith(
      'remote-command',
      'executor-1',
      'applied',
    );
  });

  it('takes over a paused Run with no live owner when resume is requested', async () => {
    const { service, engine, executions } = createSubject({
      engineStatus: 'unknown',
      runStatus: 'paused',
    });
    const resume = jest.fn(async () => true);
    service.setResumePersistedRun(resume);

    const result = await service.request('run-1', 'resume');

    expect(result.status).toBe('applied');
    expect(result.result?.currentStatus).toBe('running');
    expect(resume).toHaveBeenCalledWith('run-1');
    expect(engine.resumeRun).not.toHaveBeenCalled();
    expect(executions.completeControl).toHaveBeenCalledWith(
      result.commandId,
      'executor-1',
      'applied',
    );
  });

  it('keeps resume pending while another owner still holds the paused Run', async () => {
    const { service, executions } = createSubject({ engineStatus: 'unknown', runStatus: 'paused' });
    service.setResumePersistedRun(async () => false);

    const result = await service.request('run-1', 'resume');

    expect(result.status).toBe('pending');
    expect(executions.claimControl).toHaveBeenCalled();
    expect(executions.releaseControlClaim).toHaveBeenCalledWith(result.commandId, 'executor-1');
  });

  it('rejects a paused Run whose persisted snapshot is unsafe to resume', async () => {
    const { service } = createSubject({ engineStatus: 'unknown', runStatus: 'paused' });
    service.setResumePersistedRun(async () => {
      throw new RunRecoveryNotReadyError('Attempt is still running');
    });

    const result = await service.request('run-1', 'resume');

    expect(result).toMatchObject({ status: 'rejected', error: 'Attempt is still running' });
  });
});
