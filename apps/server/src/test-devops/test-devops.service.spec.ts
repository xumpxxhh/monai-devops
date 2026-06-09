import { Test, TestingModule } from '@nestjs/testing';
import { TestDevopsService } from './test-devops.service';
import type { WorkflowLifecycleEvent, WorkflowStep } from '@monai-devops/core-engine';

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

  it('runWorkflowWithObserver emits workflow lifecycle events', async () => {
    const events: WorkflowLifecycleEvent[] = [];

    const { result } = service.runWorkflowWithObserver(
      {
        id: 'observer-test',
        name: 'Observer Test',
        steps: [
          {
            id: 'integration-step',
            name: 'Integration Test',
            plugin: 'test-plugin',
            config: { type: 'runner' },
          } satisfies WorkflowStep,
        ],
      },
      async (event) => {
        events.push(event);
      },
    );

    const runResult = await result;

    expect(runResult.success).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      'workflow:start',
      'step:start',
      'step:finished',
      'workflow:finished',
    ]);
  });
});
