import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import type { ExecutionRepository } from './execution.repository.js';
import { WorkerTransportController } from './worker-transport.controller.js';

describe('WorkerTransportController', () => {
  const token = 'test-worker-token-with-at-least-32-characters';
  const repository = {
    claimWorkerDispatch: jest.fn(async () => undefined),
    acceptRegisteredWorkerMessage: jest.fn(async () => ({ accepted: false, code: 'duplicate' })),
  };

  function controller(configuredToken?: string) {
    return new WorkerTransportController(
      repository as unknown as ExecutionRepository,
      {
        get: jest.fn((key: string) =>
          key === 'EXECUTOR_WORKER_HTTP_TOKEN' ? configuredToken : undefined,
        ),
      } as unknown as ConfigService,
    );
  }

  beforeEach(() => {
    repository.claimWorkerDispatch.mockClear();
    repository.acceptRegisteredWorkerMessage.mockClear();
  });

  it('keeps the transport disabled without an adequately long configured token', async () => {
    await expect(
      controller().claim(`Bearer ${token}`, { workerId: 'worker-1' }),
    ).rejects.toMatchObject({
      status: 503,
    });
    await expect(controller('short').message(`Bearer ${token}`, {})).rejects.toMatchObject({
      status: 503,
    });
    expect(repository.claimWorkerDispatch).not.toHaveBeenCalled();
  });

  it('rejects missing and incorrect bearer credentials before repository access', async () => {
    await expect(
      controller(token).claim(undefined, { workerId: 'worker-1' }),
    ).rejects.toMatchObject({
      status: 401,
    });
    await expect(controller(token).message('Bearer incorrect', {})).rejects.toMatchObject({
      status: 401,
    });
    expect(repository.claimWorkerDispatch).not.toHaveBeenCalled();
    expect(repository.acceptRegisteredWorkerMessage).not.toHaveBeenCalled();
  });

  it('passes authenticated claims and messages to the durable repository', async () => {
    const subject = controller(token);
    expect(await subject.claim(`Bearer ${token}`, { workerId: 'worker-1' })).toEqual({
      assignment: null,
    });
    expect(repository.claimWorkerDispatch).toHaveBeenCalledWith('worker-1', 30_000);
    const message = { kind: 'heartbeat' };
    expect(await subject.message(`Bearer ${token}`, message)).toEqual({
      accepted: false,
      code: 'duplicate',
    });
    expect(repository.acceptRegisteredWorkerMessage).toHaveBeenCalledWith(message, 30_000);
  });

  it('bounds long-poll wait time before looking for work', async () => {
    await expect(
      controller(token).claim(`Bearer ${token}`, { workerId: 'worker-1', waitMs: 20_001 }),
    ).rejects.toMatchObject({ status: 400 });
    expect(repository.claimWorkerDispatch).not.toHaveBeenCalled();
  });

  it('retries an empty claim within the requested long-poll window', async () => {
    const assignment = { dispatch: { protocolVersion: 1 }, claim: { leaseToken: 'lease' } };
    repository.claimWorkerDispatch
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(assignment as never);
    expect(
      await controller(token).claim(`Bearer ${token}`, { workerId: 'worker-1', waitMs: 500 }),
    ).toEqual({ assignment });
    expect(repository.claimWorkerDispatch).toHaveBeenCalledTimes(2);
  });
});
