import type { WorkflowDefinition } from '@monai-devops/core-engine';

/** Stable IDs make development seeding idempotent without overwriting Web edits. */
export const developmentWorkflows: WorkflowDefinition[] = [
  {
    id: 'dev-core3-basic',
    name: '[开发示例] Core-3 基础执行',
    steps: [
      {
        id: 'print-input',
        name: '打印输入',
        kind: 'plugin',
        plugin: 'print-plugin',
        config: { data: { scenario: 'core3-basic', nested: { value: 42 } } },
      },
      {
        id: 'unit-check',
        name: '单元检查',
        kind: 'plugin',
        plugin: 'test-plugin',
        config: { type: 'unit' },
        dependsOn: ['print-input'],
      },
    ],
  },
  {
    id: 'dev-core3-parallel',
    name: '[开发示例] Core-3 并行与依赖',
    steps: [
      {
        id: 'unit-check',
        name: '并行单元检查',
        kind: 'plugin',
        plugin: 'test-plugin',
        config: { type: 'unit' },
      },
      {
        id: 'integration-check',
        name: '并行集成检查',
        kind: 'plugin',
        plugin: 'test-plugin',
        config: { type: 'integration' },
      },
      {
        id: 'summary',
        name: '汇总完成',
        kind: 'plugin',
        plugin: 'print-plugin',
        config: { data: '两个并行步骤已完成' },
        dependsOn: ['unit-check', 'integration-check'],
      },
    ],
  },
  {
    id: 'dev-core3-secret',
    name: '[开发示例] Core-3 Secret 引用',
    steps: [
      {
        id: 'resolve-secret',
        name: '验证 Worker Secret',
        kind: 'plugin',
        plugin: 'test-plugin',
        config: { type: 'secret' },
        secretRefs: { apiKey: 'secret://env/CORE3_DEV_SECRET' },
      },
    ],
  },
  {
    id: 'dev-core3-large-result',
    name: '[开发示例] Core-3 大结果引用',
    steps: [
      {
        id: 'large-result',
        name: '生成大结果',
        kind: 'plugin',
        plugin: 'test-plugin',
        config: { type: 'large' },
      },
    ],
  },
  {
    id: 'dev-core3-failure',
    name: '[开发示例] Core-3 预期失败',
    steps: [
      {
        id: 'fail',
        name: '触发插件失败',
        kind: 'plugin',
        plugin: 'test-plugin',
        config: { type: 'failure' },
      },
    ],
  },
  {
    id: 'dev-core3-wait',
    name: '[开发示例] Core-3 等待与取消（需 signal 唤醒）',
    steps: [
      {
        id: 'wait-approval',
        name: '等待 approved 信号',
        kind: 'plugin',
        plugin: 'test-plugin',
        config: { type: 'wait' },
        mayWait: true,
        retryPolicy: { maxAttempts: 2, backoffMs: 100 },
      },
    ],
  },
];
