import { Test, TestingModule } from '@nestjs/testing';
import { TestService } from './test.service';

describe('TestService', () => {
  let service: TestService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TestService],
    }).compile();

    service = module.get<TestService>(TestService);
  });

  it('runs integration workflow via core-engine', async () => {
    const result = await service.runIntegrationTest();

    expect(result.success).toBe(true);
    expect(result.message).toBe('集成测试执行成功');
    expect(result.workflowId).toBe('integration-closed-loop');
  });
});
