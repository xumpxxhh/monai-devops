import { Injectable } from '@nestjs/common';
import {
  createEngine,
  type WorkflowDefinition,
  type WorkflowLifecycleEvent,
  type WorkflowRunResult,
  type WorkflowStep,
} from '@monai-devops/core-engine';
import { testPlugin } from 'test-plugin';

export interface IntegrationTestResult {
  success: boolean;
  message: string;
  workflowId: string;
}

export interface WorkflowRunSession {
  result: Promise<WorkflowRunResult>;
  destroy: () => void;
}

@Injectable()
export class TestDevopsService {
  runWorkflowWithObserver(
    workflow: WorkflowDefinition,
    onEvent: (event: WorkflowLifecycleEvent) => void | Promise<void>,
  ): WorkflowRunSession {
    const engine = createEngine({
      plugins: [testPlugin],
      observer: { onEvent },
    });

    let destroyed = false;
    const destroy = () => {
      if (destroyed) return;
      destroyed = true;
      engine.destroy();
    };

    const result = engine.runWorkflow(workflow).finally(() => {
      destroy();
    });

    return { result, destroy };
  }

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
          config: { type: 'runner' },
        } satisfies WorkflowStep,
      ],
    };

    const { result } = this.runWorkflowWithObserver(workflow, (event) => {
      // console.log(JSON.stringify(event, null, 2));
    });

    const run = await result;

    return {
      success: run.success,
      message: run.results[0]?.pluginResult?.message ?? '',
      workflowId,
    };
  }
}
