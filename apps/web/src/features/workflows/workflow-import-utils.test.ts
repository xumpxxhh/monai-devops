import { describe, expect, it } from 'vitest';
import { StepKinds, type WorkflowDefinition } from '@monai-devops/core-engine';
import {
  buildImportPreview,
  collectMissingPlugins,
  definitionToDraft,
  parseWorkflowJson,
  suggestImportName,
  WorkflowJsonParseError,
} from './workflow-import-utils';

const sampleDefinition: WorkflowDefinition = {
  id: 'wf-old',
  name: '示例工作流',
  stateSchema: { type: 'object', properties: { count: { type: 'number' } } },
  steps: [
    {
      id: 'step-a',
      name: '步骤 A',
      plugin: 'test-plugin',
      config: { type: 'unit' },
      dependsOn: [],
    },
    {
      id: 'step-b',
      name: '步骤 B',
      kind: StepKinds.SET_STATE,
      patch: { count: 1 },
      dependsOn: ['step-a'],
    },
  ],
};

describe('parseWorkflowJson', () => {
  it('parses valid workflow JSON', () => {
    const parsed = parseWorkflowJson(JSON.stringify(sampleDefinition));
    expect(parsed.name).toBe('示例工作流');
    expect(parsed.steps).toHaveLength(2);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseWorkflowJson('{')).toThrow(WorkflowJsonParseError);
  });

  it('rejects missing name', () => {
    expect(() => parseWorkflowJson(JSON.stringify({ steps: [{ name: 'a', id: '1' }] }))).toThrow(
      '缺少有效的 name 字段',
    );
  });

  it('rejects empty steps', () => {
    expect(() => parseWorkflowJson(JSON.stringify({ name: 'x', steps: [] }))).toThrow(
      'steps 必须是非空数组',
    );
  });
});

describe('definitionToDraft', () => {
  it('converts plugin and set_state steps with dependsOn remapping', () => {
    const { draft, skippedWorkflowStepCount } = definitionToDraft(sampleDefinition);

    expect(skippedWorkflowStepCount).toBe(0);
    expect(draft.steps).toHaveLength(2);
    expect(draft.steps[0]).toMatchObject({
      clientRef: 'copy-0',
      name: '步骤 A',
      plugin: 'test-plugin',
    });
    expect(draft.steps[1]).toMatchObject({
      clientRef: 'copy-1',
      name: '步骤 B',
      kind: StepKinds.SET_STATE,
      dependsOn: ['copy-0'],
    });
    expect(draft).not.toHaveProperty('id');
    expect(draft.stateSchema).toEqual(sampleDefinition.stateSchema);
  });

  it('skips workflow ref steps', () => {
    const withWorkflowStep: WorkflowDefinition = {
      ...sampleDefinition,
      steps: [
        ...sampleDefinition.steps,
        {
          id: 'step-c',
          name: '子流',
          kind: StepKinds.WORKFLOW,
          workflowRef: { importId: 'imp-1' },
          dependsOn: ['step-b'],
        },
      ],
    };

    const { draft, skippedWorkflowStepCount } = definitionToDraft(withWorkflowStep);
    expect(skippedWorkflowStepCount).toBe(1);
    expect(draft.steps).toHaveLength(2);
  });

  it('remaps $ref.fromStepId in config and patch to clientRef', () => {
    const withRefs: WorkflowDefinition = {
      id: 'wf-refs',
      name: '引用重映射',
      stateSchema: { type: 'object', properties: { msg: { type: 'string' } } },
      steps: [
        {
          id: 'step-a',
          name: '步骤 A',
          plugin: 'test-plugin',
          config: { type: 'unit' },
          dependsOn: [],
        },
        {
          id: 'step-b',
          name: '步骤 B',
          kind: StepKinds.SET_STATE,
          patch: {
            msg: { $ref: { fromStepId: 'step-a', path: ['message'] } },
          },
          dependsOn: ['step-a'],
        },
        {
          id: 'step-c',
          name: '步骤 C',
          plugin: 'print-plugin',
          config: {
            data: { $ref: { fromStepId: 'step-a', path: ['message'] } },
            stateEcho: { $ref: { fromStepId: '__workflow_state__', path: ['msg'] } },
          },
          dependsOn: ['step-b'],
        },
      ],
    };

    const { draft } = definitionToDraft(withRefs);
    expect(draft.steps[1]).toMatchObject({
      kind: StepKinds.SET_STATE,
      patch: {
        msg: { $ref: { fromStepId: 'copy-0', path: ['message'] } },
      },
    });
    expect(draft.steps[2]).toMatchObject({
      plugin: 'print-plugin',
      config: {
        data: { $ref: { fromStepId: 'copy-0', path: ['message'] } },
        stateEcho: { $ref: { fromStepId: '__workflow_state__', path: ['msg'] } },
      },
    });
  });
});

describe('collectMissingPlugins', () => {
  it('returns plugins not in registered set', () => {
    const missing = collectMissingPlugins(sampleDefinition, new Set(['other-plugin']));
    expect(missing).toEqual(['test-plugin']);
  });

  it('returns empty when all plugins registered', () => {
    const missing = collectMissingPlugins(sampleDefinition, new Set(['test-plugin']));
    expect(missing).toEqual([]);
  });
});

describe('suggestImportName', () => {
  it('keeps original name when not taken', () => {
    expect(suggestImportName('新工作流', new Set())).toBe('新工作流');
  });

  it('appends import suffix when name exists', () => {
    expect(suggestImportName('示例工作流', new Set(['示例工作流']))).toBe('示例工作流 (导入)');
  });
});

describe('buildImportPreview', () => {
  it('aggregates step counts and missing plugins', () => {
    const preview = buildImportPreview(
      sampleDefinition,
      new Set(['test-plugin']),
      new Set(['示例工作流']),
    );

    expect(preview.stepCount).toBe(2);
    expect(preview.skippedWorkflowStepCount).toBe(0);
    expect(preview.missingPlugins).toEqual([]);
    expect(preview.defaultName).toBe('示例工作流 (导入)');
  });
});
