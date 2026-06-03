/**
 * 编排器注入到 PluginContext 的字段名常量
 * @module context-keys
 */

export const WorkflowContextKeys = {
  workflowId: "workflowId",
  stepId: "stepId",
  previousResults: "previousResults",
  artifacts: "artifacts",
  runId: "runId",
  traceId: "traceId",
} as const;
