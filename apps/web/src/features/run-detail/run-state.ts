import type {
  RunStatus,
  SerializedWorkflowLifecycleEvent,
  SerializedWorkflowStep,
  WorkflowRunResultSerialized,
} from '../../shared/types';
import type { StepUiStatus } from '../../shared/types/status';
import type { Edge, Node } from '@xyflow/react';
import { directedEdgeOptions } from '../../shared/dag/flow-layout';
import { getStepKind, StepKinds, type StepKind } from '@monai-devops/core-engine';

export interface DagStepNodeData {
  label: string;
  plugin: string;
  kind?: StepKind;
  status: StepUiStatus;
  [key: string]: unknown;
}

export interface StepIterationView {
  index: number;
  status: StepUiStatus;
  childRunId?: string;
  state?: unknown;
  success?: boolean;
}

export interface StepView {
  id: string;
  name: string;
  kind: StepKind;
  plugin?: string;
  status: StepUiStatus;
  dependsOn: string[];
  resourceType?: string;
  priority?: number;
  result?: unknown;
  failureKind?: string;
  skipReason?: string;
  error?: { name: string; message: string };
  pluginResult?: unknown;
  /** workflow 步骤的迭代时间线（父 run 视角） */
  iterations?: StepIterationView[];
  /** 带 parent 的子 run 事件日志（按 iteration 分桶） */
  nestedLogs?: Record<number, LogLine[]>;
}

export type PluginLogStream = 'stdout' | 'stderr';

export interface LogLineNesting {
  parentStepId: string;
  /** 展示用父步骤名，如「引用子工作流」 */
  parentStepName: string;
  /** 0-based；UI 展示为「第 N 轮」时 +1 */
  iteration: number;
}

export interface LogLine {
  id: string;
  ts: string;
  kind: 'event' | 'log' | 'stream' | 'error';
  eventType?: string;
  stepId?: string;
  stepName?: string;
  level?: string;
  stream?: PluginLogStream;
  message: string;
  /** 子工作流事件：用于主日志分组折叠，不把 UUID 拼进 message */
  nesting?: LogLineNesting;
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
  status: RunStatus;
  finalResult?: WorkflowRunResultSerialized;
  startedAt?: string;
}

type WorkflowStepLike = {
  id: string;
  name: string;
  kind?: StepKind;
  plugin?: string;
  dependsOn?: string[];
};

function resolveKind(step: { kind?: StepKind; plugin?: string } | undefined): StepKind {
  if (!step) return StepKinds.PLUGIN;
  return getStepKind(step as { kind?: StepKind });
}

function displayPlugin(step: { kind?: StepKind; plugin?: string } | undefined): string {
  const kind = resolveKind(step);
  if (kind === StepKinds.SET_STATE) return 'set_state';
  if (kind === StepKinds.WORKFLOW) return 'workflow';
  return step?.plugin ?? '';
}

export function createInitialRunState(
  runId: string,
  workflow?: {
    id: string;
    name: string;
    steps?: WorkflowStepLike[];
  },
): RunState {
  const steps: Record<string, StepView> = {};
  const edges: Array<{ from: string; to: string }> = [];

  for (const step of workflow?.steps ?? []) {
    const kind = resolveKind(step);
    steps[step.id] = {
      id: step.id,
      name: step.name,
      kind,
      plugin: step.plugin,
      status: 'idle',
      dependsOn: step.dependsOn ?? [],
      ...(kind === StepKinds.WORKFLOW ? { iterations: [] } : {}),
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
    const stream = event.log?.stream as PluginLogStream | undefined;
    if (stream) {
      return {
        id,
        ts: formatTs(),
        kind: 'stream',
        stepId: event.step?.id,
        stepName: event.step?.name,
        level: event.log?.level,
        stream,
        message: event.log?.message ?? '',
        raw: event,
      };
    }
    return {
      id,
      ts: formatTs(),
      kind: 'log',
      eventType: event.type,
      stepId: event.step?.id,
      stepName: event.step?.name,
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
    stepName: event.step?.name,
    message: event.type,
    raw: event,
  };
}

function appendLogLine(logs: LogLine[], line: LogLine): LogLine[] {
  const last = logs.at(-1);
  if (
    line.kind === 'stream' &&
    last?.kind === 'stream' &&
    last.stream === line.stream &&
    last.stepId === line.stepId
  ) {
    const merged = [...logs];
    merged[merged.length - 1] = {
      ...last,
      message: last.message + line.message,
    };
    return merged;
  }
  return [...logs, line];
}

export function appendPluginLogEvent(
  logs: LogLine[],
  event: SerializedWorkflowLifecycleEvent,
): LogLine[] {
  if (event.type !== 'plugin:log') return logs;
  return appendLogLine(logs, eventToLog(event, `${logs.length + 1}`));
}

function ensureStepShell(
  steps: Record<string, StepView>,
  step: SerializedWorkflowStep | undefined,
): StepView | undefined {
  if (!step) return undefined;
  const prev = steps[step.id];
  const kind = resolveKind(step);
  if (prev) return prev;
  return {
    id: step.id,
    name: step.name,
    kind,
    plugin: step.plugin,
    status: 'idle',
    dependsOn: [],
    ...(kind === StepKinds.WORKFLOW ? { iterations: [] } : {}),
  };
}

function applyParentScopedEvent(
  state: RunState,
  event: SerializedWorkflowLifecycleEvent,
  logLine: LogLine,
): RunState {
  const parent = event.parent!;
  const steps = { ...state.steps };
  const parentStep = steps[parent.stepId];
  const nesting: LogLineNesting = {
    parentStepId: parent.stepId,
    parentStepName: parentStep?.name ?? parent.stepId,
    iteration: parent.iteration,
  };
  const nestedLine: LogLine = { ...logLine, nesting };

  if (!parentStep) {
    // 父步骤不在本 run DAG 中：仅保留顶层日志，不新建顶层节点
    return {
      ...state,
      logs: appendLogLine(state.logs, nestedLine),
    };
  }

  const nestedLogs = { ...(parentStep.nestedLogs ?? {}) };
  const bucket = appendLogLine(nestedLogs[parent.iteration] ?? [], nestedLine);
  nestedLogs[parent.iteration] = bucket;

  const iterations = [...(parentStep.iterations ?? [])];
  if (!iterations.some((it) => it.index === parent.iteration)) {
    iterations.push({ index: parent.iteration, status: 'running' });
    iterations.sort((a, b) => a.index - b.index);
  }

  steps[parent.stepId] = {
    ...parentStep,
    nestedLogs,
    iterations,
  };

  return {
    ...state,
    steps,
    // 顶层 logs 也记一条，便于总览分组；不改 counts
    logs: appendLogLine(state.logs, nestedLine),
    counts: state.counts,
  };
}

function applyIterationEvent(
  state: RunState,
  event: SerializedWorkflowLifecycleEvent,
  logs: LogLine[],
): RunState {
  const steps = { ...state.steps };
  const stepId = event.step?.id;
  if (!stepId) {
    return { ...state, logs, counts: recalcCounts(steps) };
  }

  const prev = ensureStepShell(steps, event.step) ?? steps[stepId];
  if (!prev) {
    return { ...state, logs, counts: recalcCounts(steps) };
  }

  const iterations = [...(prev.iterations ?? [])];
  const index = event.iteration ?? 0;
  const existingIdx = iterations.findIndex((it) => it.index === index);

  if (event.type === 'workflow:iteration:start') {
    const next: StepIterationView = {
      index,
      status: 'running',
      childRunId: undefined,
    };
    if (existingIdx >= 0) iterations[existingIdx] = { ...iterations[existingIdx], ...next };
    else iterations.push(next);
  }

  if (event.type === 'workflow:iteration:finished') {
    const child = event.childResult;
    const next: StepIterationView = {
      index,
      status: child?.success === false ? 'failed' : 'completed',
      childRunId: child?.childRunId,
      state: child?.state,
      success: child?.success,
    };
    if (existingIdx >= 0) iterations[existingIdx] = { ...iterations[existingIdx], ...next };
    else iterations.push(next);
  }

  iterations.sort((a, b) => a.index - b.index);
  steps[stepId] = {
    ...prev,
    kind: StepKinds.WORKFLOW,
    iterations,
  };

  return {
    ...state,
    steps,
    logs,
    counts: recalcCounts(steps),
  };
}

export function applyRunEvent(state: RunState, event: SerializedWorkflowLifecycleEvent): RunState {
  const logId = `${state.logs.length + 1}`;
  const logLine = eventToLog(event, logId);

  // 子 run 事件：禁止污染父 DAG 顶层 steps
  if (event.parent) {
    return applyParentScopedEvent(state, event, logLine);
  }

  // 防御：无 parent 但 workflowRunId 与当前顶层 run 不一致（如历史 step:queued 绕过 emit）
  // 只记日志，不新建/改写顶层节点
  if (
    event.workflowRunId &&
    state.runId &&
    event.workflowRunId !== state.runId &&
    (event.type === 'step:queued' ||
      event.type === 'step:start' ||
      event.type === 'step:finished' ||
      event.type === 'plugin:log' ||
      event.type === 'workflow:start' ||
      event.type === 'workflow:finished' ||
      event.type === 'workflow:paused' ||
      event.type === 'workflow:resumed' ||
      event.type === 'workflow:cancelled')
  ) {
    return {
      ...state,
      logs: appendLogLine(state.logs, logLine),
    };
  }

  const logs = appendLogLine(state.logs, logLine);
  const steps = { ...state.steps };
  let { runId, workflowName, workflowId, status, finalResult, startedAt } = state;

  if (event.workflowRunId) runId = event.workflowRunId;
  if (event.meta?.workflowId) workflowId = event.meta.workflowId;

  if (event.type === 'workflow:iteration:start' || event.type === 'workflow:iteration:finished') {
    return applyIterationEvent(
      { ...state, runId, workflowName, workflowId, status, finalResult, startedAt },
      event,
      logs,
    );
  }

  if (event.type === 'workflow:start') {
    const wf = event.workflow as
      | {
          name?: string;
          steps?: WorkflowStepLike[];
        }
      | undefined;
    if (wf?.name) workflowName = wf.name;
    if (wf?.steps) {
      for (const step of wf.steps) {
        if (!steps[step.id]) {
          const kind = resolveKind(step);
          steps[step.id] = {
            id: step.id,
            name: step.name,
            kind,
            plugin: step.plugin,
            status: 'idle',
            dependsOn: step.dependsOn ?? [],
            ...(kind === StepKinds.WORKFLOW ? { iterations: [] } : {}),
          };
        }
      }
    }
    startedAt = startedAt ?? formatTs();
  }

  if (event.type === 'step:queued' && event.step) {
    const prev = ensureStepShell(steps, event.step);
    steps[event.step.id] = {
      ...prev!,
      id: event.step.id,
      name: event.step.name ?? prev?.name ?? event.step.id,
      kind: resolveKind(event.step),
      plugin: event.step.plugin ?? prev?.plugin,
      status: 'queued',
      dependsOn: prev?.dependsOn ?? [],
      resourceType: event.resourceType,
      priority: event.priority,
      iterations: prev?.iterations,
      nestedLogs: prev?.nestedLogs,
    };
  }

  if (event.type === 'step:start' && event.step) {
    const prev = ensureStepShell(steps, event.step);
    steps[event.step.id] = {
      ...prev!,
      id: event.step.id,
      name: event.step.name ?? prev?.name ?? event.step.id,
      kind: resolveKind(event.step),
      plugin: event.step.plugin ?? prev?.plugin,
      status: 'running',
      dependsOn: prev?.dependsOn ?? [],
      iterations: prev?.iterations,
      nestedLogs: prev?.nestedLogs,
    };
  }

  if (event.type === 'step:finished' && event.step) {
    const prev = ensureStepShell(steps, event.step);
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
      ...prev!,
      id: event.step.id,
      name: event.step.name ?? prev?.name ?? event.step.id,
      kind: resolveKind(event.step),
      plugin: event.step.plugin ?? prev?.plugin,
      status: stepStatus,
      dependsOn: prev?.dependsOn ?? [],
      result,
      failureKind: result?.failureKind,
      skipReason: result?.skipReason,
      error: result?.error,
      pluginResult: result?.pluginResult,
      iterations: prev?.iterations,
      nestedLogs: prev?.nestedLogs,
    };
  }

  if (event.type === 'workflow:cancelled') {
    status = 'running';
  }

  if (event.type === 'workflow:paused') {
    status = 'paused';
  }

  if (event.type === 'workflow:resumed') {
    status = 'running';
  }

  if (event.type === 'workflow:finished') {
    const result = event.result as WorkflowRunResultSerialized;
    finalResult = result;
    status =
      result.status === 'cancelled'
        ? 'cancelled'
        : result.status === 'failed'
          ? 'failed'
          : 'finished';
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
    steps?: WorkflowStepLike[];
  },
  events: SerializedWorkflowLifecycleEvent[],
  finalResult?: WorkflowRunResultSerialized,
): RunState {
  let state = createInitialRunState(runId, workflow);
  for (const event of events) {
    state = applyRunEvent(state, event);
  }
  if (finalResult) {
    const terminalStatus: RunStatus =
      finalResult.status === 'cancelled'
        ? 'cancelled'
        : finalResult.status === 'failed'
          ? 'failed'
          : 'finished';
    state = { ...state, status: terminalStatus, finalResult };
  }
  return state;
}

export function runStepsToFlow(
  steps: Record<string, StepView>,
  edges: Array<{ from: string; to: string }>,
): { nodes: Node<DagStepNodeData>[]; edges: Edge[] } {
  const nodes: Node<DagStepNodeData>[] = Object.values(steps).map((step) => ({
    id: step.id,
    type: 'step',
    position: { x: 0, y: 0 },
    data: {
      label: step.name,
      plugin: displayPlugin(step),
      kind: step.kind,
      status: step.status,
    },
  }));

  const flowEdges: Edge[] = edges.map((edge) => ({
    id: `${edge.from}->${edge.to}`,
    source: edge.from,
    target: edge.to,
    ...directedEdgeOptions,
  }));

  return { nodes, edges: flowEdges };
}
