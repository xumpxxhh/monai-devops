import { jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { EngineService } from '../engine/engine.service.js';
import { TestDevopsService } from './test-devops.service.js';

describe('TestDevopsService', () => {
  let service: TestDevopsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TestDevopsService,
        {
          provide: EngineService,
          useValue: {
            runWorkflow: jest.fn().mockResolvedValue({
              success: true,
              workflowId: 'integration-closed-loop',
              results: [{ pluginResult: { message: '集成测试执行成功' } }],
            }),
          },
        },
      ],
    }).compile();

    service = module.get<TestDevopsService>(TestDevopsService);
  });

  it('runs integration workflow via shared engine', async () => {
    const result = await service.runIntegrationTest();

    expect(result.success).toBe(true);
    expect(result.message).toBe('集成测试执行成功');
    expect(result.workflowId).toBe('integration-closed-loop');
  });
});
