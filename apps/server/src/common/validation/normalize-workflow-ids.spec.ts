import { isPluginStep, WORKFLOW_STATE_REF_ID } from '@monai-devops/core-engine';
import { normalizeWorkflowIds } from './normalize-workflow-ids.js';

describe('normalizeWorkflowIds', () => {
  it('generates workflow and step ids when omitted on create', () => {
    const result = normalizeWorkflowIds({
      name: 'Test',
      steps: [
        {
          clientRef: 'a',
          name: 'Step A',
          plugin: 'test-plugin',
          config: { type: 'integration' },
        },
      ],
    });

    expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(result.steps[0]).not.toHaveProperty('clientRef');
  });

  it('remaps dependsOn via clientRef', () => {
    const result = normalizeWorkflowIds({
      name: 'DAG',
      steps: [
        {
          clientRef: 'b',
          name: 'B',
          plugin: 'test-plugin',
          config: {},
          dependsOn: ['a'],
        },
        {
          clientRef: 'a',
          name: 'A',
          plugin: 'test-plugin',
          config: {},
        },
      ],
    });

    const stepA = result.steps.find((s) => s.name === 'A')!;
    const stepB = result.steps.find((s) => s.name === 'B')!;
    expect(stepB.dependsOn).toEqual([stepA.id]);
  });

  it('keeps known step ids on update and assigns new ids for new steps', () => {
    const knownStepIds = new Set(['existing-1']);
    const result = normalizeWorkflowIds(
      {
        name: 'Updated',
        steps: [
          {
            id: 'existing-1',
            name: 'Old',
            plugin: 'test-plugin',
            config: {},
          },
          {
            clientRef: 'new-ref',
            name: 'New',
            plugin: 'test-plugin',
            config: {},
            dependsOn: ['existing-1'],
          },
        ],
      },
      { workflowId: 'wf-1', knownStepIds },
    );

    expect(result.id).toBe('wf-1');
    expect(result.steps[0].id).toBe('existing-1');
    expect(result.steps[1].id).not.toBe('existing-1');
    expect(result.steps[1].dependsOn).toEqual(['existing-1']);
  });

  it('assigns fresh ids for copy without step ids', () => {
    const result = normalizeWorkflowIds({
      name: 'Copy',
      steps: [
        {
          clientRef: 'copy-1',
          name: 'B',
          plugin: 'test-plugin',
          config: {},
          dependsOn: ['copy-0'],
        },
        {
          clientRef: 'copy-0',
          name: 'A',
          plugin: 'test-plugin',
          config: {},
        },
      ],
    });

    const stepA = result.steps.find((s) => s.name === 'A')!;
    const stepB = result.steps.find((s) => s.name === 'B')!;
    expect(stepA.id).not.toBe('copy-0');
    expect(stepB.dependsOn).toEqual([stepA.id]);
  });

  it('remaps ContextRef.fromStepId via clientRef together with dependsOn', () => {
    const result = normalizeWorkflowIds({
      name: 'Inject',
      steps: [
        {
          clientRef: 'up',
          name: 'Up',
          plugin: 'test-plugin',
          config: { type: 'unit' },
        },
        {
          clientRef: 'down',
          name: 'Down',
          plugin: 'test-plugin',
          config: {
            type: { $ref: { fromStepId: 'up', path: ['type'] } },
          },
          dependsOn: ['up'],
        },
      ],
    });

    const stepUp = result.steps.find((s) => s.name === 'Up')!;
    const stepDown = result.steps.find((s) => s.name === 'Down')!;
    expect(stepDown.dependsOn).toEqual([stepUp.id]);
    expect(isPluginStep(stepDown)).toBe(true);
    if (isPluginStep(stepDown)) {
      expect(stepDown.config).toEqual({
        type: { $ref: { fromStepId: stepUp.id, path: ['type'] } },
      });
    }
  });

  it('remaps ContextRef.fromStepId when step ids are regenerated', () => {
    const result = normalizeWorkflowIds({
      name: 'Regen',
      steps: [
        {
          id: 'old-a',
          clientRef: 'old-a',
          name: 'A',
          plugin: 'test-plugin',
          config: {},
        },
        {
          id: 'old-b',
          clientRef: 'old-b',
          name: 'B',
          plugin: 'test-plugin',
          config: {
            type: { $ref: { fromStepId: 'old-a', path: ['type'] } },
          },
          dependsOn: ['old-a'],
        },
      ],
    });

    const stepA = result.steps.find((s) => s.name === 'A')!;
    const stepB = result.steps.find((s) => s.name === 'B')!;
    expect(stepA.id).not.toBe('old-a');
    expect(isPluginStep(stepB)).toBe(true);
    if (isPluginStep(stepB)) {
      expect(stepB.config).toEqual({
        type: { $ref: { fromStepId: stepA.id, path: ['type'] } },
      });
    }
  });

  it('preserves WORKFLOW_STATE_REF_ID ContextRef without remapping', () => {
    const result = normalizeWorkflowIds({
      name: 'StateRef',
      stateSchema: {
        type: 'object',
        properties: { count: { type: 'number' } },
        additionalProperties: false,
      },
      steps: [
        {
          clientRef: 'reader',
          name: 'Reader',
          plugin: 'test-plugin',
          config: {
            n: { $ref: { fromStepId: WORKFLOW_STATE_REF_ID, path: ['count'] } },
          },
        },
      ],
    });

    const reader = result.steps.find((s) => s.name === 'Reader')!;
    expect(isPluginStep(reader)).toBe(true);
    if (isPluginStep(reader)) {
      expect(reader.config).toEqual({
        n: { $ref: { fromStepId: WORKFLOW_STATE_REF_ID, path: ['count'] } },
      });
    }
  });
});
