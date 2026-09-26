import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { EXECUTION_REPOSITORY, type ExecutionRepository } from './execution.repository.js';
import { WorkerTransportController } from './worker-transport.controller.js';

describe('worker HTTP transport', () => {
  const token = 'test-worker-token-with-at-least-32-characters';
  let app: NestExpressApplication;
  const repository = {
    claimWorkerDispatch: jest.fn(async () => undefined),
    acceptRegisteredWorkerMessage: jest.fn(async () => ({
      accepted: false,
      code: 'invalid_identity',
    })),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [WorkerTransportController],
      providers: [
        { provide: EXECUTION_REPOSITORY, useValue: repository as unknown as ExecutionRepository },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => (key === 'EXECUTOR_WORKER_HTTP_TOKEN' ? token : undefined),
          },
        },
      ],
    }).compile();
    app = module.createNestApplication<NestExpressApplication>({ bodyParser: false });
    app.useBodyParser('json', { limit: '2mb' });
    app.setGlobalPrefix('api/v1/devops');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects unauthenticated claims and accepts authenticated long-poll requests', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/devops/executor-workers/claim')
      .send({ workerId: 'worker-1' })
      .expect(401);
    const response = await request(app.getHttpServer())
      .post('/api/v1/devops/executor-workers/claim')
      .set('Authorization', `Bearer ${token}`)
      .send({ workerId: 'worker-1', waitMs: 0 })
      .expect(201);
    expect(response.body).toEqual({ assignment: null });
    expect(repository.claimWorkerDispatch).toHaveBeenCalledWith('worker-1', 30_000);
  });

  it('routes authenticated messages without accepting a client dispatch', async () => {
    const payload = { execution: { attemptId: 'missing' }, kind: 'heartbeat' };
    const response = await request(app.getHttpServer())
      .post('/api/v1/devops/executor-workers/messages')
      .set('Authorization', `Bearer ${token}`)
      .send(payload)
      .expect(201);
    expect(response.body).toEqual({ accepted: false, code: 'invalid_identity' });
    expect(repository.acceptRegisteredWorkerMessage).toHaveBeenCalledWith(payload, 30_000);
  });

  it('parses a protocol-sized JSON request beyond the framework default limit', async () => {
    const payload = { kind: 'complete', result: { success: true, data: 'x'.repeat(150_000) } };
    await request(app.getHttpServer())
      .post('/api/v1/devops/executor-workers/messages')
      .set('Authorization', `Bearer ${token}`)
      .send(payload)
      .expect(201);
    expect(repository.acceptRegisteredWorkerMessage).toHaveBeenCalledWith(payload, 30_000);
  });
});
