/**
 * 工作流生命周期事件 type 常量
 * @module observer/event-types
 */

export const WorkflowEventTypes = {
  WORKFLOW_START: 'workflow:start',
  WORKFLOW_FINISHED: 'workflow:finished',
  WORKFLOW_CANCELLED: 'workflow:cancelled',
  WORKFLOW_PAUSED: 'workflow:paused',
  WORKFLOW_RESUMED: 'workflow:resumed',
  WORKFLOW_ITERATION_START: 'workflow:iteration:start',
  WORKFLOW_ITERATION_FINISHED: 'workflow:iteration:finished',
  STEP_QUEUED: 'step:queued',
  STEP_START: 'step:start',
  STEP_FINISHED: 'step:finished',
  PLUGIN_LOG: 'plugin:log',
} as const;

export type WorkflowEventType = (typeof WorkflowEventTypes)[keyof typeof WorkflowEventTypes];
