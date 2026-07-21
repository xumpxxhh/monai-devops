import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import request from 'supertest';
import { App } from 'supertest/types';
import WebSocket from 'ws';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { assertTestDatabaseUrl } from '../src/common/storage/assert-test-database-url.js';

const GLOBAL_API_PREFIX = 'api/v1/devops';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    assertTestDatabaseUrl();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app));
    app.setGlobalPrefix(GLOBAL_API_PREFIX);
    await app.init();
  }, 30_000);

  afterAll(async () => {
    const prisma = app.get(PrismaService);
    await prisma.runEvent.deleteMany();
    await prisma.run.deleteMany();
    await prisma.workflow.deleteMany();
    await app.close();
  });

  it(`/${GLOBAL_API_PREFIX} (GET)`, () => {
    return request(app.getHttpServer())
      .get(`/${GLOBAL_API_PREFIX}`)
      .expect(200)
      .expect('Hello World!');
  });

  it(`/${GLOBAL_API_PREFIX}/test-devops (GET)`, () => {
    return request(app.getHttpServer())
      .get(`/${GLOBAL_API_PREFIX}/test-devops`)
      .expect(200)
      .expect({
        success: true,
        message: '集成测试执行成功',
        workflowId: 'integration-closed-loop',
      });
  }, 30_000);

  it(`ws://${GLOBAL_API_PREFIX}/test-devops/ws streams workflow events`, async () => {
    const server = app.getHttpServer() as import('node:net').Server;
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 3000;
    const wsUrl = `ws://127.0.0.1:${port}/${GLOBAL_API_PREFIX}/test-devops/ws`;

    const messages = await new Promise<Array<{ type: string; event?: { type: string } }>>(
      (resolve, reject) => {
        const received: Array<{ type: string; event?: { type: string } }> = [];
        const ws = new WebSocket(wsUrl);

        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error('WebSocket test timed out'));
        }, 20_000);

        ws.on('open', () => {
          ws.send(
            JSON.stringify({
              type: 'run',
              workflow: {
                id: 'integration-closed-loop',
                name: 'Core Engine Integration Test',
                steps: [
                  {
                    id: 'integration-step',
                    name: 'Integration Test',
                    plugin: 'test-plugin',
                    config: { type: 'integration' },
                  },
                ],
              },
            }),
          );
        });

        ws.on('message', (data) => {
          const message = JSON.parse(data.toString()) as {
            type: string;
            event?: { type: string };
          };
          received.push(message);

          if (message.type === 'done' || message.type === 'error') {
            clearTimeout(timeout);
            ws.close();
            resolve(received);
          }
        });

        ws.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      },
    );

    expect(
      messages.some(
        (message) => message.type === 'event' && message.event?.type === 'workflow:start',
      ),
    ).toBe(true);
    // workflow:finished 由 RunManager 以 done 消息发出，不另发 event
    expect(messages.some((message) => message.type === 'done')).toBe(true);
    expect(messages[messages.length - 1]?.type).toBe('done');
  }, 30_000);
});
