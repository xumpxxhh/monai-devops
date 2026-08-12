import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from '@monai-devops/plugin-sdk';
import {
  createWorkflowExecutor,
  toPreviousResultsData,
  isContextRef,
  isWorkflowStateRef,
  extractContextReferences,
  resolveConfigReferences,
  validateWorkflowContextReferences,
  WORKFLOW_STATE_REF_ID,
  WorkflowValidationError,
  type WorkflowDefinition,
  type ExecutionResult,
  type PluginExecutor,
} from '../executor/index.js';
import { StepFailureKinds, StepStatuses } from '../errors.js';

const TEST_RUN_ID = 'ctx-ref-run';

function completed(stepId: string, data: unknown): ExecutionResult {
  return {
    stepId,
    status: StepStatuses.COMPLETED,
    success: true,
    result: data,
    pluginResult: { success: true, data },
  };
}

describe('toPreviousResultsData', () => {
  it('writes only COMPLETED + success data', () => {
    const results = new Map<string, ExecutionResult>([
      ['a', completed('a', { answer: 1 })],
      [
        'b',
        {
          stepId: 'b',
          status: StepStatuses.SKIPPED,
          success: true,
          result: { skipped: true },
        },
      ],
      [
        'c',
        {
          stepId: 'c',
          status: StepStatuses.FAILED,
          success: false,
          pluginResult: { success: false, message: 'fail' },
        },
      ],
      [
        'd',
        {
          stepId: 'd',
          status: StepStatuses.COMPLETED,
          success: true,
          pluginResult: { success: true },
        },
      ],
      [
        'e',
        {
          stepId: 'e',
          status: StepStatuses.COMPLETED,
          success: false,
          pluginResult: { success: false, data: { x: 1 } },
        },
      ],
    ]);

    assert.deepEqual(toPreviousResultsData(results), { a: { answer: 1 } });
  });
});

describe('isContextRef / extractContextReferences', () => {
  it('accepts valid ContextRef', () => {
    assert.equal(isContextRef({ $ref: { fromStepId: 'a', path: ['x', '0'] } }), true);
  });

  it('rejects invalid shapes', () => {
    assert.equal(isContextRef(null), false);
    assert.equal(isContextRef({ $ref: 'string' }), false);
    assert.equal(isContextRef({ $ref: { fromStepId: 1, path: [] } }), false);
    assert.equal(isContextRef({ $ref: { fromStepId: 'a', path: [1] } }), false);
    assert.equal(isContextRef({ fromStepId: 'a', path: [] }), false);
  });

  it('extracts nested refs', () => {
    const refs = extractContextReferences({
      a: { $ref: { fromStepId: 's1', path: ['x'] } },
      nested: {
        b: [{ $ref: { fromStepId: 's2', path: [] } }],
      },
    });
    assert.equal(refs.length, 2);
    assert.equal(refs[0]!.$ref.fromStepId, 's1');
    assert.equal(refs[1]!.$ref.fromStepId, 's2');
  });
});

describe('resolveConfigReferences', () => {
  const data = {
    'step-a': {
      answer: '42',
      usage: { tokens: 10 },
      choices: [{ content: 'hello' }],
      'key.with.dot': 1,
      中文: null,
    },
  };

  it('replaces whole fields and preserves types', () => {
    const resolved = resolveConfigReferences(
      {
        answer: { $ref: { fromStepId: 'step-a', path: ['answer'] } },
        usageInfo: { $ref: { fromStepId: 'step-a', path: ['usage'] } },
        firstChoice: { $ref: { fromStepId: 'step-a', path: ['choices', '0', 'content'] } },
        whole: { $ref: { fromStepId: 'step-a', path: [] } },
        literal: 'keep',
      },
      data,
      'step-b',
    );

    assert.deepEqual(resolved, {
      answer: '42',
      usageInfo: { tokens: 10 },
      firstChoice: 'hello',
      whole: data['step-a'],
      literal: 'keep',
    });
  });

  it('supports special keys and null', () => {
    const resolved = resolveConfigReferences(
      {
        dotted: { $ref: { fromStepId: 'step-a', path: ['key.with.dot'] } },
        cn: { $ref: { fromStepId: 'step-a', path: ['中文'] } },
      },
      data,
      'step-b',
    );
    assert.deepEqual(resolved, { dotted: 1, cn: null });
  });

  it('fails when fromStepId missing', () => {
    assert.throws(
      () =>
        resolveConfigReferences(
          { x: { $ref: { fromStepId: 'missing', path: [] } } },
          data,
          'step-b',
        ),
      (err: unknown) =>
        err instanceof Error &&
        (err as { kind?: string }).kind === StepFailureKinds.CONFIG_RESOLUTION,
    );
  });

  it('fails when path missing', () => {
    assert.throws(
      () =>
        resolveConfigReferences(
          { x: { $ref: { fromStepId: 'step-a', path: ['nope'] } } },
          data,
          'step-b',
        ),
      (err: unknown) =>
        err instanceof Error &&
        (err as { kind?: string }).kind === StepFailureKinds.CONFIG_RESOLUTION,
    );
  });
});

describe('validateWorkflowContextReferences', () => {
  const resultSchema = z.object({ answer: z.string() });

  it('rejects non-ancestor / missing / no resultSchema', () => {
    const workflow: WorkflowDefinition = {
      id: 'w',
      name: 'w',
      steps: [
        { id: 'a', name: 'A', plugin: 'p-a', config: {} },
        { id: 'b', name: 'B', plugin: 'p-b', config: {}, dependsOn: ['a'] },
        {
          id: 'c',
          name: 'C',
          plugin: 'p-c',
          config: {
            x: { $ref: { fromStepId: 'b', path: ['answer'] } },
          },
          dependsOn: ['a'],
        },
      ],
    };

    assert.throws(
      () =>
        validateWorkflowContextReferences(workflow, {
          resolvePluginResultSchema: (name) => (name === 'p-b' ? resultSchema : undefined),
        }),
      WorkflowValidationError,
    );

    assert.throws(
      () =>
        validateWorkflowContextReferences(
          {
            ...workflow,
            steps: [
              ...workflow.steps.slice(0, 2),
              {
                id: 'c',
                name: 'C',
                plugin: 'p-c',
                config: { x: { $ref: { fromStepId: 'missing', path: [] } } },
                dependsOn: ['a'],
              },
            ],
          },
          { resolvePluginResultSchema: () => resultSchema },
        ),
      WorkflowValidationError,
    );

    assert.throws(
      () =>
        validateWorkflowContextReferences(
          {
            id: 'w2',
            name: 'w2',
            steps: [
              { id: 'a', name: 'A', plugin: 'p-a', config: {} },
              {
                id: 'b',
                name: 'B',
                plugin: 'p-b',
                config: { x: { $ref: { fromStepId: 'a', path: [] } } },
                dependsOn: ['a'],
              },
            ],
          },
          { resolvePluginResultSchema: () => undefined },
        ),
      WorkflowValidationError,
    );
  });

  it('accepts legal ancestor refs', () => {
    assert.doesNotThrow(() =>
      validateWorkflowContextReferences(
        {
          id: 'w',
          name: 'w',
          steps: [
            { id: 'a', name: 'A', plugin: 'p-a', config: {} },
            {
              id: 'b',
              name: 'B',
              plugin: 'p-b',
              config: { x: { $ref: { fromStepId: 'a', path: ['answer'] } } },
              dependsOn: ['a'],
            },
          ],
        },
        { resolvePluginResultSchema: () => resultSchema },
      ),
    );
  });

  it('accepts workflow state refs on any step when stateSchema declared', () => {
    assert.doesNotThrow(() =>
      validateWorkflowContextReferences({
        id: 'w',
        name: 'w',
        stateSchema: {
          type: 'object',
          properties: { count: { type: 'number' } },
          additionalProperties: false,
        },
        steps: [
          {
            id: 'solo',
            name: 'Solo',
            plugin: 'p',
            config: { n: { $ref: { fromStepId: WORKFLOW_STATE_REF_ID, path: ['count'] } } },
          },
        ],
      }),
    );
  });

  it('rejects workflow state refs when stateSchema missing', () => {
    assert.throws(
      () =>
        validateWorkflowContextReferences({
          id: 'w',
          name: 'w',
          steps: [
            {
              id: 'solo',
              name: 'Solo',
              plugin: 'p',
              config: { n: { $ref: { fromStepId: WORKFLOW_STATE_REF_ID, path: [] } } },
            },
          ],
        }),
      WorkflowValidationError,
    );
  });
});

describe('workflow state $ref resolution', () => {
  it('isWorkflowStateRef detects sentinel', () => {
    assert.equal(
      isWorkflowStateRef({ $ref: { fromStepId: WORKFLOW_STATE_REF_ID, path: ['x'] } }),
      true,
    );
    assert.equal(isWorkflowStateRef({ $ref: { fromStepId: 'a', path: [] } }), false);
  });

  it('resolves path from runState option', () => {
    const resolved = resolveConfigReferences(
      {
        n: { $ref: { fromStepId: WORKFLOW_STATE_REF_ID, path: ['count'] } },
        whole: { $ref: { fromStepId: WORKFLOW_STATE_REF_ID, path: [] } },
      },
      {},
      'step-x',
      { runState: { count: 7, flag: true } },
    );
    assert.deepEqual(resolved, { n: 7, whole: { count: 7, flag: true } });
  });

  it('fails when runState missing', () => {
    assert.throws(
      () =>
        resolveConfigReferences(
          { n: { $ref: { fromStepId: WORKFLOW_STATE_REF_ID, path: ['count'] } } },
          {},
          'step-x',
        ),
      (err: unknown) =>
        err instanceof Error &&
        (err as { kind?: string }).kind === StepFailureKinds.CONFIG_RESOLUTION,
    );
  });
});

describe('executeStep config resolution', () => {
  it('injects upstream data into downstream config', async () => {
    const received: unknown[] = [];
    const pluginExecutor: PluginExecutor = async (_name, config) => {
      received.push(config);
      if ((config as { phase?: string }).phase === 'up') {
        return { success: true, data: { answer: 'ok', nested: { n: 1 } } };
      }
      return { success: true, data: { got: config } };
    };

    const executor = createWorkflowExecutor({
      pluginExecutor,
      resolvePluginResultSchema: () => z.object({ answer: z.string() }),
    });

    const result = await executor.executeWorkflow(TEST_RUN_ID, {
      id: 'inject',
      name: 'inject',
      steps: [
        { id: 'up', name: 'Up', plugin: 'p', config: { phase: 'up' } },
        {
          id: 'down',
          name: 'Down',
          plugin: 'p',
          dependsOn: ['up'],
          config: {
            phase: 'down',
            answer: { $ref: { fromStepId: 'up', path: ['answer'] } },
            n: { $ref: { fromStepId: 'up', path: ['nested', 'n'] } },
          },
        },
      ],
    });

    assert.equal(result.success, true);
    assert.deepEqual(received[1], { phase: 'down', answer: 'ok', n: 1 });
  });

  it('fails with CONFIG_RESOLUTION when previousResultsData missing (dry-run style)', async () => {
    const executor = createWorkflowExecutor({
      pluginExecutor: async () => ({ success: true, data: {} }),
    });

    const result = await executor.executeStep(
      'dry-run-id',
      {
        id: 'dry',
        name: 'Dry',
        plugin: 'p',
        config: { x: { $ref: { fromStepId: 'missing', path: [] } } },
      },
      {
        workflowId: 'dry',
        stepId: 'dry',
      },
    );

    assert.equal(result.status, StepStatuses.FAILED);
    assert.equal(result.failureKind, StepFailureKinds.CONFIG_RESOLUTION);
  });

  it('injects workflow state into plugin config without ancestor dependency', async () => {
    let received: unknown;
    const pluginExecutor: PluginExecutor = async (_name, config) => {
      received = config;
      return { success: true, data: { got: config } };
    };

    const executor = createWorkflowExecutor({ pluginExecutor });
    const result = await executor.executeWorkflow(
      `${TEST_RUN_ID}-state`,
      {
        id: 'state-ref',
        name: 'state-ref',
        stateSchema: {
          type: 'object',
          properties: { count: { type: 'number' } },
          additionalProperties: false,
        },
        steps: [
          {
            id: 'reader',
            name: 'Reader',
            plugin: 'p',
            config: {
              n: { $ref: { fromStepId: WORKFLOW_STATE_REF_ID, path: ['count'] } },
            },
          },
        ],
      },
      {},
      { initialState: { count: 42 } },
    );

    assert.equal(result.success, true);
    assert.deepEqual(received, { n: 42 });
  });
});
