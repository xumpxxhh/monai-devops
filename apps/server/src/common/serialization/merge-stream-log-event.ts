import type { PluginLogStream } from '@monai-devops/plugin-sdk';
import type { SerializedWorkflowLifecycleEvent } from './serialize-workflow-event.js';

interface PluginLogShape {
  message?: string;
  timestamp?: number;
  stream?: PluginLogStream;
}

interface StepShape {
  id?: string;
}

function asPluginLog(event: SerializedWorkflowLifecycleEvent): PluginLogShape | undefined {
  if (event.type !== 'plugin:log') return undefined;
  return event.log as PluginLogShape | undefined;
}

function asStepId(event: SerializedWorkflowLifecycleEvent): string | undefined {
  return (event.step as StepShape | undefined)?.id;
}

export function isStreamPluginLog(event: SerializedWorkflowLifecycleEvent): boolean {
  const log = asPluginLog(event);
  return log?.stream === 'stdout' || log?.stream === 'stderr';
}

export function canMergeStreamLogs(
  last: SerializedWorkflowLifecycleEvent,
  incoming: SerializedWorkflowLifecycleEvent,
): boolean {
  if (!isStreamPluginLog(last) || !isStreamPluginLog(incoming)) {
    return false;
  }

  const lastLog = asPluginLog(last);
  const incomingLog = asPluginLog(incoming);
  if (!lastLog || !incomingLog) return false;

  return lastLog.stream === incomingLog.stream && asStepId(last) === asStepId(incoming);
}

export function mergeStreamLogInto(
  target: SerializedWorkflowLifecycleEvent,
  incoming: SerializedWorkflowLifecycleEvent,
): void {
  const targetLog = asPluginLog(target);
  const incomingLog = asPluginLog(incoming);
  if (!targetLog || !incomingLog) return;

  targetLog.message = `${targetLog.message ?? ''}${incomingLog.message ?? ''}`;
  if (incomingLog.timestamp !== undefined) {
    targetLog.timestamp = incomingLog.timestamp;
  }
}
