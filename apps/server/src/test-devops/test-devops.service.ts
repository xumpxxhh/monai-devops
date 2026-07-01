import { Injectable } from '@nestjs/common';
import type { WorkflowDefinition, WorkflowStep } from '@monai-devops/core-engine';
import { EngineService } from '../engine/engine.service.js';

export interface IntegrationTestResult {
  success: boolean;
  message: string;
  workflowId: string;
}

@Injectable()
export class TestDevopsService {
  constructor(private readonly engineService: EngineService) {}

  async runIntegrationTest(): Promise<IntegrationTestResult> {
    const workflowId = 'integration-closed-loop';
    const workflow: WorkflowDefinition = {
      id: workflowId,
      name: 'Core Engine Integration Test',
      steps: [
        {
          id: 'integration-step',
          name: 'Integration Test',
          plugin: 'test-plugin',
          config: { type: 'integration' },
        } satisfies WorkflowStep,
      ],
    };

    const run = await this.engineService.runWorkflow(workflow);

    return {
      success: run.success,
      message: run.results[0]?.pluginResult?.message ?? '',
      workflowId,
    };
  }
}
