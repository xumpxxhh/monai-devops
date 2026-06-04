import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module.js';

const GLOBAL_API_PREFIX = 'api/v1/devops';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix(GLOBAL_API_PREFIX);
    await app.init();
  });

  it(`/${GLOBAL_API_PREFIX} (GET)`, () => {
    return request(app.getHttpServer())
      .get(`/${GLOBAL_API_PREFIX}`)
      .expect(200)
      .expect('Hello World!');
  });

  it(`/${GLOBAL_API_PREFIX}/test (GET)`, () => {
    return request(app.getHttpServer())
      .get(`/${GLOBAL_API_PREFIX}/test`)
      .expect(200)
      .expect({
        success: true,
        message: '集成测试执行成功',
        workflowId: 'integration-closed-loop',
      });
  });

  afterEach(async () => {
    await app.close();
  });
});
