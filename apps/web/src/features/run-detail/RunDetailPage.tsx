import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowLeft,
  faChevronRight,
  faCopy,
  faBan,
  faPause,
  faPlay,
  faGripLines,
  faGripLinesVertical,
} from '@fortawesome/free-solid-svg-icons';
import {
  ReactFlow,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { runsApi } from '../../shared/api/runs';
import { useWorkflowRun } from '../../shared/hooks/useWorkflowRun';
import {
  assignEdgeHandles,
  directedEdgeOptions,
  getLayoutedNodes,
} from '../../shared/dag/flow-layout';
import { StatusBadge } from '../../shared/status/StatusBadge';
import { ProgressBar } from '../../shared/status/ProgressBar';
import { TabsBar } from '../../shared/ui/Tabs';
import { Drawer } from '../../shared/ui/Drawer';
import { Checkbox } from '../../shared/ui/form';
import { WsPill } from '../../shared/ws/WsPill';
import { RUN_STATUS_META } from '../../shared/types/status';
import type { RunStatus, WorkflowRunResultSerialized } from '../../shared/types';
import { DagStepNode } from './DagStepNode';
import {
  applyRunEvent,
  createInitialRunState,
  hydrateRunState,
  runStepsToFlow,
  type DagStepNodeData,
  type LogLine,
  type RunState,
  type StepView,
} from './run-state';

type LogFilter = 'all' | 'logs' | 'errors';
type LayoutMode = 'vertical' | 'horizontal';

type LogSegment =
  | { type: 'line'; log: LogLine }
  | {
      type: 'group';
      key: string;
      parentStepName: string;
      iteration: number;
      lines: LogLine[];
    };

function nestGroupKey(parentStepId: string, iteration: number): string {
  return `${parentStepId}#${iteration}`;
}

/** 将连续且 nesting 相同的日志合成一组，便于折叠展示 */
function groupFilteredLogs(logs: LogLine[]): LogSegment[] {
  const segments: LogSegment[] = [];
  for (const log of logs) {
    const nest = log.nesting;
    if (!nest) {
      segments.push({ type: 'line', log });
      continue;
    }
    const key = nestGroupKey(nest.parentStepId, nest.iteration);
    const last = segments.at(-1);
    if (last?.type === 'group' && last.key === key) {
      last.lines.push(log);
    } else {
      segments.push({
        type: 'group',
        key,
        parentStepName: nest.parentStepName,
        iteration: nest.iteration,
        lines: [log],
      });
    }
  }
  return segments;
}

const LAYOUT_MODE_STORAGE_KEY = 'run-detail-layout-mode';

function readLayoutMode(): LayoutMode {
  try {
    const stored = localStorage.getItem(LAYOUT_MODE_STORAGE_KEY);
    if (stored === 'vertical' || stored === 'horizontal') return stored;
  } catch {
    // ignore
  }
  return 'vertical';
}

/** 对齐 plugin-sdk PluginLogLevel：debug | info | warn | error */
function logLevelTextClass(level?: string, stream?: 'stdout' | 'stderr'): string {
  switch (level) {
    case 'debug':
      return 'text-faint';
    case 'warn':
      return 'text-warning';
    case 'error':
      return 'text-failed';
    case 'info':
      return 'text-ink';
    default:
      return stream === 'stderr' ? 'text-failed' : 'text-ink';
  }
}

function renderLogLine(log: LogLine, stepNameById: Record<string, string> | undefined): ReactNode {
  const messageClass =
    log.kind === 'error' ? 'text-failed' : logLevelTextClass(log.level, log.stream);

  if (log.kind === 'stream') {
    return (
      <pre key={log.id} className={`whitespace-pre-wrap break-words ${messageClass}`}>
        {log.message}
      </pre>
    );
  }

  return (
    <div key={log.id} className="log-line">
      <span className="text-faint">{log.ts}</span>{' '}
      <span className={log.kind === 'log' ? 'text-running' : 'text-muted'}>
        [{log.level ?? log.eventType ?? log.kind}]
      </span>{' '}
      {log.stepId && (
        <span className="text-brand">
          {log.stepName ?? stepNameById?.[log.stepId] ?? log.stepId}
        </span>
      )}{' '}
      <span className={messageClass}>{log.message}</span>
    </div>
  );
}

const ACTIVE_RUN_STATUSES = new Set<RunStatus>(['queued', 'running', 'paused', 'pausing']);
const TERMINAL_RUN_STATUSES = new Set<RunStatus>(['finished', 'failed', 'cancelled', 'rejected']);
const CANCELLABLE_STATUSES = new Set<RunStatus>(['queued', 'running', 'paused', 'pausing']);
const PAUSABLE_STATUSES = new Set<RunStatus>(['running', 'pausing']);
const RESUMABLE_STATUSES = new Set<RunStatus>(['paused', 'pausing']);

function terminalStatusFromResult(result: WorkflowRunResultSerialized): RunStatus {
  if (result.status === 'cancelled') return 'cancelled';
  if (result.status === 'failed') return 'failed';
  return 'finished';
}

const nodeTypes = { step: DagStepNode };

function RunDagCanvas({
  nodes,
  edges,
  onNodeClick,
  fitViewKey,
}: {
  nodes: Node<DagStepNodeData>[];
  edges: Edge[];
  onNodeClick: (nodeId: string) => void;
  fitViewKey: string;
}) {
  const { fitView } = useReactFlow();

  useEffect(() => {
    if (!fitViewKey) return;
    requestAnimationFrame(() =>
      fitView({ padding: 0.06, maxZoom: 1, minZoom: 0.75, duration: 200 }),
    );
  }, [fitViewKey, fitView]);

  return (
    <div className="flex-1 relative dag-flow-canvas min-h-0">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        onNodeClick={(_, node) => onNodeClick(node.id)}
        proOptions={{ hideAttribution: true }}
        fitView
      />
      {nodes.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <p className="text-sm text-faint">暂无步骤</p>
        </div>
      )}
    </div>
  );
}

function RunDagPanel({
  runState,
  layoutMode,
  onNodeClick,
}: {
  runState: RunState | null;
  layoutMode: LayoutMode;
  onNodeClick: (step: StepView) => void;
}) {
  const [nodes, setNodes] = useNodesState<Node<DagStepNodeData>>([]);
  const [edges, setEdges] = useEdgesState<Edge>([]);
  const layoutKeyRef = useRef('');

  const structureKey = useMemo(() => {
    if (!runState) return '';
    const stepIds = Object.keys(runState.steps).sort().join(',');
    const edgeList = runState.edges
      .map((e) => `${e.from}->${e.to}`)
      .sort()
      .join(',');
    return `${stepIds}|${edgeList}`;
  }, [runState]);

  useEffect(() => {
    if (!runState || !structureKey) {
      setNodes([]);
      setEdges([]);
      layoutKeyRef.current = '';
      return;
    }

    if (layoutKeyRef.current === structureKey) return;

    const flow = runStepsToFlow(runState.steps, runState.edges);
    const layoutedNodes = getLayoutedNodes(flow.nodes, flow.edges, 'LR');
    const layoutedEdges = assignEdgeHandles(layoutedNodes, flow.edges);
    setNodes(layoutedNodes);
    setEdges(layoutedEdges);
    layoutKeyRef.current = structureKey;
  }, [structureKey, runState, setNodes, setEdges]);

  useEffect(() => {
    if (!runState) return;

    setNodes((prevNodes) => {
      let changed = false;
      const nextNodes = prevNodes.map((node) => {
        const step = runState.steps[node.id];
        if (!step) return node;

        const displayPlugin =
          step.kind === 'set_state'
            ? 'set_state'
            : step.kind === 'workflow'
              ? 'workflow'
              : (step.plugin ?? '');
        const current = node.data;
        if (
          current.label === step.name &&
          current.plugin === displayPlugin &&
          current.kind === step.kind &&
          current.status === step.status
        ) {
          return node;
        }

        changed = true;
        return {
          ...node,
          data: {
            ...current,
            label: step.name,
            plugin: displayPlugin,
            kind: step.kind,
            status: step.status,
          },
        };
      });
      return changed ? nextNodes : prevNodes;
    });

    setEdges((prevEdges) => {
      let changed = false;
      const nextEdges = prevEdges.map((edge) => {
        const isActive = runState.steps[edge.target]?.status === 'running';
        if (!!edge.animated === isActive) return edge;

        changed = true;
        return {
          ...edge,
          animated: isActive,
          style: isActive ? { stroke: '#0EA5E9', strokeWidth: 2 } : directedEdgeOptions.style,
          markerEnd: isActive
            ? { ...directedEdgeOptions.markerEnd, color: '#0EA5E9' }
            : directedEdgeOptions.markerEnd,
        };
      });
      return changed ? nextEdges : prevEdges;
    });
  }, [runState, setNodes, setEdges]);

  const panelClass =
    layoutMode === 'vertical'
      ? 'shrink-0 h-[min(42vh,280px)] min-h-[180px] border-b border-line'
      : 'flex-1 min-h-0 min-w-0 border-r border-line';

  return (
    <div className={`flex flex-col bg-panel ${panelClass}`}>
      <h2 className="shrink-0 text-xs font-medium text-faint uppercase tracking-wider px-4 py-2">
        DAG 状态
      </h2>
      <ReactFlowProvider>
        <RunDagCanvas
          nodes={nodes}
          edges={edges}
          onNodeClick={(nodeId) => {
            const step = runState?.steps[nodeId];
            if (step) onNodeClick(step);
          }}
          fitViewKey={structureKey ? `${structureKey}|${layoutMode}` : ''}
        />
      </ReactFlowProvider>
    </div>
  );
}

export default function RunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const [runState, setRunState] = useState<RunState | null>(null);
  const [recordStatus, setRecordStatus] = useState<RunStatus>('running');
  const [logFilter, setLogFilter] = useState<LogFilter>('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const [logScrollPaused, setLogScrollPaused] = useState(false);
  const [controlLoading, setControlLoading] = useState(false);
  const [drawerStep, setDrawerStep] = useState<StepView | null>(null);
  const [wsBanner, setWsBanner] = useState('');
  const [wsSubscribe, setWsSubscribe] = useState<{
    runId: string;
    fromEventIndex: number;
  } | null>(null);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(readLayoutMode);
  /** 折叠的嵌套日志组；未记录视为展开 */
  const [collapsedNestGroups, setCollapsedNestGroups] = useState<Record<string, boolean>>({});
  const logEndRef = useRef<HTMLDivElement>(null);

  const handleLayoutModeChange = useCallback((mode: LayoutMode) => {
    setLayoutMode(mode);
    try {
      localStorage.setItem(LAYOUT_MODE_STORAGE_KEY, mode);
    } catch {
      // ignore
    }
  }, []);

  const handleEvent = useCallback((event: Parameters<typeof applyRunEvent>[1]) => {
    setRunState((prev) => {
      if (!prev) return prev;
      const next = applyRunEvent(prev, event);
      if (next.status !== prev.status) {
        setRecordStatus((current) =>
          TERMINAL_RUN_STATUSES.has(current) && ACTIVE_RUN_STATUSES.has(next.status)
            ? current
            : next.status,
        );
      }
      return next;
    });
  }, []);

  const handleDone = useCallback((result: WorkflowRunResultSerialized) => {
    const terminalStatus = terminalStatusFromResult(result);
    setRecordStatus(terminalStatus);
    setRunState((prev) => (prev ? { ...prev, status: terminalStatus, finalResult: result } : prev));
    setWsSubscribe(null);
  }, []);

  const { status: wsStatus } = useWorkflowRun({
    runId,
    autoSubscribe: wsSubscribe?.runId === runId,
    fromEventIndex: wsSubscribe?.fromEventIndex ?? 0,
    onEvent: handleEvent,
    onDone: handleDone,
    onError: (msg) => setWsBanner(msg),
  });

  useEffect(() => {
    if (!runId) return;

    let cancelled = false;

    async function load() {
      const record = await runsApi.get(runId!);
      if (cancelled) return;

      setRecordStatus(record.status);
      const hydrated = hydrateRunState(
        record.runId,
        record.workflowSnapshot,
        record.events,
        record.result,
      );
      setRunState({ ...hydrated, status: record.status });

      if (ACTIVE_RUN_STATUSES.has(record.status)) {
        setWsSubscribe({ runId: runId!, fromEventIndex: record.events.length });
      } else {
        setWsSubscribe(null);
      }
    }

    load().catch((e) => {
      setRunState(createInitialRunState(runId!, undefined));
      setWsSubscribe(null);
      setWsBanner('无法加载运行详情');
      toast.error(e instanceof Error ? e.message : '无法加载运行详情');
    });

    return () => {
      cancelled = true;
    };
  }, [runId]);

  const handleCancelRun = async (mode: 'best-effort' | 'hard' = 'best-effort') => {
    if (!runId || controlLoading) return;
    if (mode === 'hard') {
      const confirmed = window.confirm(
        '强制取消将中断正在执行的步骤。未协作退出的插件可能在超时后被标记为跳过。确定继续？',
      );
      if (!confirmed) return;
    }
    setControlLoading(true);
    try {
      const result = await runsApi.cancel(runId, { mode });
      setRecordStatus(result.status as RunStatus);
      if (result.cancelled) {
        toast.success(mode === 'hard' ? '已请求强制取消' : '已请求取消(至当前步骤完成)');
      }
      if (result.status === 'cancelled') {
        setWsSubscribe(null);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '取消失败');
    } finally {
      setControlLoading(false);
    }
  };

  const handlePauseRun = async () => {
    if (!runId || controlLoading) return;
    setControlLoading(true);
    try {
      const result = await runsApi.pause(runId);
      setRecordStatus(result.status as RunStatus);
      toast.success('运行已暂停');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '暂停失败');
    } finally {
      setControlLoading(false);
    }
  };

  const handleResumeRun = async () => {
    if (!runId || controlLoading) return;
    setControlLoading(true);
    try {
      const result = await runsApi.resume(runId);
      setRecordStatus(result.status as RunStatus);
      setWsSubscribe((prev) => (prev?.runId === runId ? prev : { runId, fromEventIndex: 0 }));
      toast.success('运行已继续');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '继续失败');
    } finally {
      setControlLoading(false);
    }
  };

  const lastLogMessage = runState?.logs.at(-1)?.message;

  useEffect(() => {
    if (autoScroll && !logScrollPaused) {
      logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [runState?.logs.length, lastLogMessage, autoScroll, logScrollPaused]);

  const filteredLogs = useMemo(() => {
    const logs = runState?.logs ?? [];
    if (logFilter === 'logs') {
      return logs.filter((log) => log.kind === 'log' || log.kind === 'stream');
    }
    if (logFilter === 'errors') {
      return logs.filter(
        (log) =>
          log.kind === 'error' ||
          log.eventType?.includes('failed') ||
          (log.kind === 'stream' && log.stream === 'stderr') ||
          log.level === 'error',
      );
    }
    return logs;
  }, [runState?.logs, logFilter]);

  const logSegments = useMemo(() => groupFilteredLogs(filteredLogs), [filteredLogs]);

  const stepNameById = useMemo(() => {
    if (!runState) return undefined;
    const map: Record<string, string> = {};
    for (const s of Object.values(runState.steps)) map[s.id] = s.name;
    return map;
  }, [runState]);

  const toggleNestGroup = useCallback((key: string) => {
    setCollapsedNestGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const meta = RUN_STATUS_META[recordStatus] ?? RUN_STATUS_META.running;
  const canCancel = CANCELLABLE_STATUSES.has(recordStatus);
  const canPause = PAUSABLE_STATUSES.has(recordStatus);
  const canResume = RESUMABLE_STATUSES.has(recordStatus);
  const isWaitingForEvents = wsSubscribe?.runId === runId;

  const logPanelClass =
    layoutMode === 'vertical'
      ? 'flex-1 min-h-0 w-full flex flex-col bg-surface'
      : 'w-[min(560px,38vw)] shrink-0 flex flex-col bg-surface';

  const logPanel = (
    <div className={logPanelClass}>
      <div className="flex items-center justify-between px-4 py-3 border-b border-line">
        <TabsBar
          items={[
            { value: 'all', label: '全部' },
            { value: 'logs', label: '仅日志' },
            { value: 'errors', label: '仅错误' },
          ]}
          value={logFilter}
          onValueChange={(v) => setLogFilter(v as LogFilter)}
        />
        <div className="flex items-center gap-2 text-xs">
          <Checkbox
            id="auto-scroll"
            checked={autoScroll}
            onCheckedChange={setAutoScroll}
            label="自动滚动"
            className="text-xs"
          />
          <button
            type="button"
            onClick={() => setLogScrollPaused((p) => !p)}
            className="px-2 py-1 rounded-ctrl hover:bg-raised text-muted"
            title="暂停/继续日志自动滚动"
          >
            {logScrollPaused ? '恢复滚动' : '暂停滚动'}
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-4 log-panel-body bg-panel min-h-0">
        {!runState && <div className="text-faint">加载日志…</div>}
        {logSegments.map((segment) => {
          if (segment.type === 'line') {
            return renderLogLine(segment.log, stepNameById);
          }

          const expanded = !collapsedNestGroups[segment.key];
          return (
            <div
              key={segment.key + segment.lines[0]?.id}
              className="my-1 rounded-ctrl bg-[#E3E8F4] border border-line overflow-hidden"
            >
              <button
                type="button"
                onClick={() => toggleNestGroup(segment.key)}
                className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-raised"
              >
                <FontAwesomeIcon
                  icon={faChevronRight}
                  className="nested-log-chevron text-faint w-3 shrink-0"
                  data-expanded={expanded ? 'true' : 'false'}
                />
                <span className="text-brand font-medium truncate">
                  {segment.parentStepName} · 第 {segment.iteration + 1} 轮
                </span>
                {!expanded && (
                  <span className="text-faint shrink-0">{segment.lines.length} 条</span>
                )}
              </button>
              <div className="nested-log-collapse" data-expanded={expanded ? 'true' : 'false'}>
                <div className="nested-log-collapse-inner">
                  <div className="pl-3 pr-2 pb-2 border-l-2 border-line ml-3 space-y-0.5">
                    {segment.lines.map((log) => renderLogLine(log, stepNameById))}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        {isWaitingForEvents && (
          <div ref={logEndRef} className="cursor-blink text-faint">
            等待事件…
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex flex-col h-screen bg-canvas">
      <header className="shrink-0 bg-surface border-b border-line px-6 py-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-3">
            <Link
              to="/runs"
              title="运行列表"
              className="inline-flex items-center justify-center h-8 w-8 text-sm text-muted hover:text-ink hover:bg-raised rounded-ctrl"
            >
              <FontAwesomeIcon icon={faArrowLeft} />
            </Link>
            <h1 className="text-lg font-semibold">{runState?.workflowName ?? '运行详情'}</h1>
            <span
              className={`inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-pill ${meta.color}`}
            >
              <span className={`w-2 h-2 rounded-full ${meta.dot}`} />
              {meta.label}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center rounded-ctrl border border-line overflow-hidden">
              <button
                type="button"
                onClick={() => handleLayoutModeChange('vertical')}
                title="上下布局"
                className={`inline-flex items-center justify-center h-8 w-8 text-sm hover:bg-raised ${
                  layoutMode === 'vertical' ? 'bg-raised text-brand' : 'text-muted'
                }`}
              >
                <FontAwesomeIcon icon={faGripLines} />
              </button>
              <button
                type="button"
                onClick={() => handleLayoutModeChange('horizontal')}
                title="左右布局"
                className={`inline-flex items-center justify-center h-8 w-8 text-sm border-l border-line hover:bg-raised ${
                  layoutMode === 'horizontal' ? 'bg-raised text-brand' : 'text-muted'
                }`}
              >
                <FontAwesomeIcon icon={faGripLinesVertical} />
              </button>
            </div>
            <WsPill status={wsStatus} />
            {canResume && (
              <button
                type="button"
                disabled={controlLoading}
                onClick={() => void handleResumeRun()}
                className="inline-flex items-center gap-2 h-8 px-3 rounded-ctrl text-sm border border-line hover:bg-raised disabled:opacity-60"
              >
                <FontAwesomeIcon icon={faPlay} />
                继续运行
              </button>
            )}
            {canPause && (
              <button
                type="button"
                disabled={controlLoading}
                onClick={() => void handlePauseRun()}
                className="inline-flex items-center gap-2 h-8 px-3 rounded-ctrl text-sm border border-line hover:bg-raised disabled:opacity-60"
              >
                <FontAwesomeIcon icon={faPause} />
                暂停运行
              </button>
            )}
            {canCancel && (
              <>
                <button
                  type="button"
                  disabled={controlLoading}
                  onClick={() => void handleCancelRun('best-effort')}
                  className="inline-flex items-center gap-2 h-8 px-3 rounded-ctrl text-sm border border-line text-failed hover:bg-raised disabled:opacity-60"
                >
                  <FontAwesomeIcon icon={faBan} />
                  取消运行
                </button>
                <button
                  type="button"
                  disabled={controlLoading}
                  onClick={() => void handleCancelRun('hard')}
                  className="inline-flex items-center gap-2 h-8 px-3 rounded-ctrl text-sm border border-line text-failed hover:bg-raised disabled:opacity-60"
                >
                  强制取消
                </button>
              </>
            )}
          </div>
        </div>

        {runState && (
          <div className="flex items-center gap-4 text-sm">
            <span className="font-mono text-muted flex items-center gap-1">
              {runState.runId.slice(0, 8)}…
              <button
                type="button"
                onClick={() => navigator.clipboard.writeText(runState.runId)}
                className="text-faint hover:text-brand"
              >
                <FontAwesomeIcon icon={faCopy} className="text-xs" />
              </button>
            </span>
            <ProgressBar {...runState.counts} />
            <span className="text-xs text-muted">
              {runState.counts.completed}/{runState.counts.total} 完成
              {runState.counts.running > 0 && ` · ${runState.counts.running} 运行中`}
            </span>
          </div>
        )}
      </header>

      {wsBanner && (
        <div className="shrink-0 bg-warning/10 border-b border-warning/30 text-warning text-sm px-6 py-2">
          {wsBanner}
        </div>
      )}

      <div
        className={`flex-1 min-h-0 ${layoutMode === 'vertical' ? 'flex flex-col' : 'flex flex-row'}`}
      >
        <RunDagPanel runState={runState} layoutMode={layoutMode} onNodeClick={setDrawerStep} />
        {logPanel}
      </div>

      <Drawer
        open={!!drawerStep}
        onOpenChange={(o) => !o && setDrawerStep(null)}
        title={drawerStep?.name ?? '步骤详情'}
      >
        {drawerStep && (
          <div className="space-y-4 text-sm">
            <div>
              <span className="text-muted">ID:</span>{' '}
              <span className="font-mono">{drawerStep.id}</span>
            </div>
            <div>
              <span className="text-muted">类型:</span> {drawerStep.kind}
            </div>
            {drawerStep.plugin && (
              <div>
                <span className="text-muted">插件:</span> {drawerStep.plugin}
              </div>
            )}
            <StatusBadge status={drawerStep.status} size="md" />
            {drawerStep.pluginResult != null && (
              <div>
                <div className="text-muted mb-1">
                  {drawerStep.kind === 'set_state' ? 'State 快照' : '结果'}
                </div>
                <pre className="bg-panel p-3 rounded-ctrl text-xs overflow-auto max-h-48">
                  {JSON.stringify(drawerStep.pluginResult, null, 2)}
                </pre>
              </div>
            )}
            {drawerStep.kind === 'workflow' && (drawerStep.iterations?.length ?? 0) > 0 && (
              <div>
                <div className="text-muted mb-2">迭代</div>
                <ul className="space-y-2">
                  {drawerStep.iterations!.map((it) => (
                    <li
                      key={it.index}
                      className="rounded-ctrl border border-line px-3 py-2 text-xs space-y-1"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono">#{it.index}</span>
                        <StatusBadge status={it.status} />
                      </div>
                      {it.state !== undefined && (
                        <pre className="bg-panel p-2 rounded-ctrl overflow-auto max-h-24">
                          {JSON.stringify(it.state, null, 2)}
                        </pre>
                      )}
                      {(drawerStep.nestedLogs?.[it.index]?.length ?? 0) > 0 && (
                        <div>
                          <div className="text-muted mb-1">嵌套日志</div>
                          <ul className="bg-panel rounded-ctrl p-2 space-y-0.5 max-h-40 overflow-auto font-mono">
                            {drawerStep.nestedLogs![it.index]!.map((line) => (
                              <li
                                key={line.id}
                                className={logLevelTextClass(line.level, line.stream)}
                              >
                                {line.message}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {drawerStep.status === 'failed' && (
              <>
                {drawerStep.failureKind && (
                  <div>
                    <span className="text-muted">失败类型:</span>{' '}
                    {drawerStep.failureKind === 'config_resolution'
                      ? '配置引用解析失败'
                      : drawerStep.failureKind === 'plugin'
                        ? '插件失败'
                        : drawerStep.failureKind === 'resource'
                          ? '资源失败'
                          : drawerStep.failureKind === 'internal'
                            ? '内部错误'
                            : drawerStep.failureKind === 'subworkflow_failed'
                              ? '子工作流失败'
                              : drawerStep.failureKind}
                  </div>
                )}
                {drawerStep.error && (
                  <pre className="bg-panel p-3 rounded-ctrl text-xs overflow-auto">
                    {JSON.stringify(drawerStep.error, null, 2)}
                  </pre>
                )}
              </>
            )}
            {drawerStep.status === 'skipped' && drawerStep.skipReason && (
              <div>
                <span className="text-muted">跳过原因:</span> {drawerStep.skipReason}
              </div>
            )}
            {drawerStep.status === 'queued' && (
              <div className="text-muted">
                等待资源 {drawerStep.resourceType ?? 'default'}
                <Link to="/resources" className="text-brand ml-2">
                  查看资源队列 →
                </Link>
              </div>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}
