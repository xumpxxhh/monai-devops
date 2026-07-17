import { WorkflowValidationError } from '@monai-devops/core-engine';
import { z } from '@monai-devops/plugin-sdk';
import { validateWorkflowDefinition } from './validate-workflow.js';

const resultSchema = z.object({ answer: z.string() });

function baseWorkflow(
  steps: Array<{
    id: string;
    name?: string;
    plugin: string;
    dependsOn?: string[];
    config: Record<string, unknown>;
  }>,
) {
  return {
    id: 'wf-1',
    name: 'demo',
    steps: steps.map((step) => ({
      name: step.name ?? step.id,
      ...step,
    })),
  };
}

describe('validateWorkflowDefinition context references', () => {
  it('accepts a valid $ref from an ancestor with resultSchema', () => {
    const workflow = baseWorkflow([
      { id: 'a', plugin: 'p-a', config: {} },
      {
        id: 'b',
        plugin: 'p-b',
        dependsOn: ['a'],
        config: {
          answer: { $ref: { fromStepId: 'a', path: ['answer'] } },
        },
      },
    ]);

    expect(() =>
      validateWorkflowDefinition(workflow, {
        resolvePluginResultSchema: (name) => (name === 'p-a' ? resultSchema : undefined),
      }),
    ).not.toThrow();
  });

  it('rejects $ref to a non-ancestor step', () => {
    const workflow = baseWorkflow([
      { id: 'a', plugin: 'p-a', config: {} },
      { id: 'b', plugin: 'p-b', config: {} },
      {
        id: 'c',
        plugin: 'p-c',
        dependsOn: ['a'],
        config: {
          answer: { $ref: { fromStepId: 'b', path: [] } },
        },
      },
    ]);

    expect(() =>
      validateWorkflowDefinition(workflow, {
        resolvePluginResultSchema: () => resultSchema,
      }),
    ).toThrow(WorkflowValidationError);
    expect(() =>
      validateWorkflowDefinition(workflow, {
        resolvePluginResultSchema: () => resultSchema,
      }),
    ).toThrow(/非祖先步骤/);
  });

  it('rejects $ref to a missing step', () => {
    const workflow = baseWorkflow([
      {
        id: 'a',
        plugin: 'p-a',
        config: {
          answer: { $ref: { fromStepId: 'missing', path: [] } },
        },
      },
    ]);

    expect(() => validateWorkflowDefinition(workflow)).toThrow(WorkflowValidationError);
    expect(() => validateWorkflowDefinition(workflow)).toThrow(/不存在的步骤/);
  });

  it('rejects $ref when upstream plugin has no resultSchema', () => {
    const workflow = baseWorkflow([
      { id: 'a', plugin: 'p-a', config: {} },
      {
        id: 'b',
        plugin: 'p-b',
        dependsOn: ['a'],
        config: {
          answer: { $ref: { fromStepId: 'a', path: ['answer'] } },
        },
      },
    ]);

    expect(() =>
      validateWorkflowDefinition(workflow, {
        resolvePluginResultSchema: () => undefined,
      }),
    ).toThrow(WorkflowValidationError);
    expect(() =>
      validateWorkflowDefinition(workflow, {
        resolvePluginResultSchema: () => undefined,
      }),
    ).toThrow(/未声明 resultSchema/);
  });

  it('still checks existence and ancestry when resolvePluginResultSchema is omitted', () => {
    const workflow = baseWorkflow([
      { id: 'a', plugin: 'p-a', config: {} },
      {
        id: 'b',
        plugin: 'p-b',
        dependsOn: ['a'],
        config: {
          answer: { $ref: { fromStepId: 'missing', path: [] } },
        },
      },
    ]);

    expect(() => validateWorkflowDefinition(workflow)).toThrow(/不存在的步骤/);
  });
});
