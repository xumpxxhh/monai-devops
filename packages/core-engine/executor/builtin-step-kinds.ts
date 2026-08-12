/**
 * 内置步骤形态清单与固定 resultSchema（供 $ref 校验与前端节点面板）
 * @module executor/builtin-step-kinds
 */

import { z } from '@monai-devops/plugin-sdk';
import type { JsonSchemaObject, StepKind } from './types.js';
import { StepKinds } from './types.js';

export interface StepKindDefinition {
  kind: Exclude<StepKind, typeof StepKinds.PLUGIN>;
  label: string;
  description: string;
  /** 该步骤形态自身的配置结构，供前端渲染属性面板 */
  configSchema: JsonSchemaObject;
}

/** set_state 步骤合成 pluginResult.data = 合并后完整 state 快照 */
export const SET_STATE_RESULT_SCHEMA = z.record(z.unknown());

/** workflow 步骤合成聚合结果形状 */
export const WORKFLOW_REF_RESULT_SCHEMA = z.object({
  state: z.unknown().optional(),
  iterations: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      state: z.unknown().optional(),
      success: z.boolean(),
    }),
  ),
  iterationCount: z.number().int().nonnegative(),
});

export const BUILTIN_STEP_KIND_DEFINITIONS: StepKindDefinition[] = [
  {
    kind: StepKinds.WORKFLOW,
    label: '引用子工作流',
    description: '执行已导入的子工作流，可选基于 state 循环',
    configSchema: {
      type: 'object',
      properties: {
        workflowRef: {
          type: 'object',
          properties: {
            importId: { type: 'string', description: 'WorkflowImport 记录 id' },
          },
          required: ['importId'],
          additionalProperties: false,
        },
        inputState: {
          description: '传入子工作流的初始 state（可含 $ref）',
        },
        loop: {
          type: 'object',
          properties: {
            maxIterations: { type: 'integer', minimum: 1 },
            until: {
              type: 'object',
              properties: {
                when: { type: 'string' },
                equals: {},
                exists: { type: 'boolean' },
              },
              required: ['when'],
            },
          },
          required: ['maxIterations'],
        },
      },
      required: ['workflowRef'],
    },
  },
  {
    kind: StepKinds.SET_STATE,
    label: '写入 State',
    description: '浅合并 patch 到当前工作流 run state',
    configSchema: {
      type: 'object',
      properties: {
        patch: {
          type: 'object',
          description: '要合并进 state 的键值（值可含 $ref）',
          additionalProperties: true,
        },
      },
      required: ['patch'],
    },
  },
];
