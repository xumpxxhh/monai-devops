import type {
  SerializedWorkflowLifecycleEvent,
  WorkflowRunResultSerialized,
} from '../../shared/types';
import type { StepUiStatus } from '../../shared/types/status';

export interface StepView {
  id: string;
  name: string;
  plugin: string;
  status: StepUiStatus;
  dependsOn: string[];
  resourceType?: string;
  priority?: number;
  result?: unknown;
  failureKind?: string;
  skipReason?: string;
  error?: { name: string; message: string };
  pluginResult?: unknown;
}

export interface LogLine {
  id: string;
  ts: string;
  kind: 'event' | 'log' | 'error';
  eventType?: string;
  stepId?: string;
  level?: string;
  message: string;
  raw?: unknown;
}

export interface RunState {
  runId: string;
  workflowName: string;
  workflowId: string;
  steps: Record<string, StepView>;
  edges: Array<{ from: string; to: string }>;
  logs: LogLine[];
  counts: {
    completed: number;
    running: number;
    queued: number;
    failed: number;
    skipped: number;
    total: number;
  };
  status: 'running' | 'finished';
  finalResult?: WorkflowRunResultSerialized;
  startedAt?: string;
}

export function createInitialRunState(
  runId: string,
  workflow?: {
    id: string;
    name: string;
    steps?: Array<{ id: string; name: string; plugin: string; dependsOn?: string[] }>;
  },
): RunState {
  const steps: Record<string, StepView> = {};
  const edges: Array<{ from: string; to: string }> = [];

  for (const step of workflow?.steps ?? []) {
    steps[step.id] = {
      id: step.id,
      name: step.name,
      plugin: step.plugin,
      status: 'idle',
      dependsOn: step.dependsOn ?? [],
    };
    for (const dep of step.dependsOn ?? []) {
      edges.push({ from: dep, to: step.id });
    }
  }

  return {
    runId,
    workflowName: workflow?.name ?? '未知工作流',
    workflowId: workflow?.id ?? '',
    steps,
    edges,
    logs: [],
    counts: {
      completed: 0,
      running: 0,
      queued: 0,
      failed: 0,
      skipped: 0,
      total: Object.keys(steps).length,
    },
    status: 'running',
  };
}

function recalcCounts(steps: Record<string, StepView>) {
  const values = Object.values(steps);
  return {
    total: values.length,
    completed: values.filter((s) => s.status === 'completed').length,
    running: values.filter((s) => s.status === 'running').length,
    queued: values.filter((s) => s.status === 'queued').length,
    failed: values.filter((s) => s.status === 'failed').length,
    skipped: values.filter((s) => s.status === 'skipped').length,
  };
}

function formatTs() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function eventToLog(event: SerializedWorkflowLifecycleEvent, id: string): LogLine {
  if (event.type === 'plugin:log') {
    return {
      id,
      ts: formatTs(),
      kind: 'log',
      eventType: event.type,
      stepId: event.step?.id,
      level: event.log?.level,
      message: event.log?.message ?? '',
      raw: event,
    };
  }
  return {
    id,
    ts: formatTs(),
    kind: 'event',
    eventType: event.type,
    stepId: event.step?.id,
    message: event.type,
    raw: event,
  };
}

export function applyRunEvent(state: RunState, event: SerializedWorkflowLifecycleEvent): RunState {
  const logId = `${state.logs.length + 1}`;
  const logs = [...state.logs, eventToLog(event, logId)];
  const steps = { ...state.steps };
  let { runId, workflowName, workflowId, status, finalResult, startedAt } = state;

  if (event.meta?.runId) runId = event.meta.runId;
  if (event.meta?.workflowId) workflowId = event.meta.workflowId;

  if (event.type === 'workflow:start') {
    const wf = event.workflow as
      | {
          name?: string;
          steps?: Array<{ id: string; name: string; plugin: string; dependsOn?: string[] }>;
        }
      | undefined;
    if (wf?.name) workflowName = wf.name;
    if (wf?.steps) {
      for (const step of wf.steps) {
        if (!steps[step.id]) {
          steps[step.id] = {
            id: step.id,
            name: step.name,
            plugin: step.plugin,
            status: 'idle',
            dependsOn: step.dependsOn ?? [],
          };
        }
      }
    }
    startedAt = startedAt ?? formatTs();
  }

  if (event.type === 'step:queued' && event.step) {
    const prev = steps[event.step.id];
    steps[event.step.id] = {
      ...prev,
      id: event.step.id,
      name: event.step.name ?? prev?.name ?? event.step.id,
      plugin: event.step.plugin ?? prev?.plugin ?? '',
      status: 'queued',
      dependsOn: prev?.dependsOn ?? [],
      resourceType: event.resourceType,
      priority: event.priority,
    };
  }

  if (event.type === 'step:start' && event.step) {
    const prev = steps[event.step.id];
    steps[event.step.id] = {
      ...prev,
      id: event.step.id,
      name: event.step.name ?? prev?.name ?? event.step.id,
      plugin: event.step.plugin ?? prev?.plugin ?? '',
      status: 'running',
      dependsOn: prev?.dependsOn ?? [],
    };
  }

  if (event.type === 'step:finished' && event.step) {
    const prev = steps[event.step.id];
    const result = event.result as
      | {
          status?: StepUiStatus;
          failureKind?: string;
          skipReason?: string;
          error?: { name: string; message: string };
          pluginResult?: unknown;
        }
      | undefined;
    const stepStatus = (result?.status ?? 'completed') as StepUiStatus;
    steps[event.step.id] = {
      ...prev,
      id: event.step.id,
      name: event.step.name ?? prev?.name ?? event.step.id,
      plugin: event.step.plugin ?? prev?.plugin ?? '',
      status: stepStatus,
      dependsOn: prev?.dependsOn ?? [],
      result,
      failureKind: result?.failureKind,
      skipReason: result?.skipReason,
      error: result?.error,
      pluginResult: result?.pluginResult,
    };
  }

  if (event.type === 'workflow:finished') {
    status = 'finished';
    finalResult = event.result as WorkflowRunResultSerialized;
  }

  return {
    ...state,
    runId,
    workflowName,
    workflowId,
    steps,
    logs,
    counts: recalcCounts(steps),
    status,
    finalResult,
    startedAt,
  };
}

export function hydrateRunState(
  runId: string,
  workflow: {
    id: string;
    name: string;
    steps?: Array<{ id: string; name: string; plugin: string; dependsOn?: string[] }>;
  },
  events: SerializedWorkflowLifecycleEvent[],
  finalResult?: WorkflowRunResultSerialized,
): RunState {
  let state = createInitialRunState(runId, workflow);
  for (const event of events) {
    state = applyRunEvent(state, event);
  }
  if (finalResult) {
    state = { ...state, status: 'finished', finalResult };
  }
  return state;
}
