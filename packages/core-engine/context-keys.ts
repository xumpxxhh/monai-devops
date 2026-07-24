/**
 * 编排器注入到 PluginContext 的字段名常量
 * @module context-keys
 */

export { PluginContextKeys } from '@monai-devops/plugin-sdk';

export const WorkflowContextKeys = {
  workflowId: 'workflowId',
  stepId: 'stepId',
  previousResults: 'previousResults',
  previousResultsData: 'previousResultsData',
  artifacts: 'artifacts',
  runId: 'runId',
  traceId: 'traceId',
  logger: 'logger',
  signal: 'signal',
  /** 当前 run state（只读感知；插件可选消费） */
  state: 'state',
} as const;
