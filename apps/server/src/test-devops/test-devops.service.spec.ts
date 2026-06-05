import { Test, TestingModule } from '@nestjs/testing';
import { TestDevopsService } from './test-devops.service';

describe('TestDevopsService', () => {
  let service: TestDevopsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TestDevopsService],
    }).compile();

    service = module.get<TestDevopsService>(TestDevopsService);
  });

  it('runs integration workflow via core-engine', async () => {
    const result = await service.runIntegrationTest();

    expect(result.success).toBe(true);
    expect(result.message).toBe('集成测试执行成功');
    expect(result.workflowId).toBe('integration-closed-loop');
  });
});
