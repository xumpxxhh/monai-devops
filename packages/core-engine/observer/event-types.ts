/**
 * 工作流生命周期事件 type 常量
 * @module observer/event-types
 */

export const WorkflowEventTypes = {
  WORKFLOW_START: 'workflow:start',
  WORKFLOW_FINISHED: 'workflow:finished',
  STEP_QUEUED: 'step:queued',
  STEP_START: 'step:start',
  STEP_FINISHED: 'step:finished',
  PLUGIN_LOG: 'plugin:log',
} as const;

export type WorkflowEventType = (typeof WorkflowEventTypes)[keyof typeof WorkflowEventTypes];
