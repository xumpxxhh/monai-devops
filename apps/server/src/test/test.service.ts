import { Injectable } from '@nestjs/common';
import {
  createEngine,
  type WorkflowDefinition,
  type WorkflowRunResult,
  type WorkflowStep,
} from '@monai-devops/core-engine';
import { testPlugin } from 'test-plugin';
export interface IntegrationTestResult {
  success: boolean;
  message: string;
  workflowId: string;
}

@Injectable()
export class TestService {
  async runIntegrationTest(): Promise<IntegrationTestResult> {
    const workflowId = 'integration-closed-loop';
    const engine = createEngine({ plugins: [testPlugin] });

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

    try {
      const run: WorkflowRunResult = await engine.runWorkflow(workflow);

      return {
        success: run.success,
        message: run.results[0]?.pluginResult?.message ?? '',
        workflowId,
      };
    } finally {
      engine.destroy();
    }
  }
}
