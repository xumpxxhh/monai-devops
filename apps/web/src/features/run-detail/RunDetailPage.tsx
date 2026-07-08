import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCopy, faBan, faPause, faPlay } from '@fortawesome/free-solid-svg-icons';
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
import { StatusBadge } from '../../shared/ui/StatusBadge';
import { ProgressBar } from '../../shared/ui/ProgressBar';
import { TabsBar } from '../../shared/ui/Tabs';
import { Drawer } from '../../shared/ui/Drawer';
import { Checkbox } from '../../shared/ui/form';
import { WsPill } from '../../shared/ui/WsPill';
import { RUN_STATUS_META } from '../../shared/types/status';
import type { RunStatus, WorkflowRunResultSerialized } from '../../shared/types';
import { DagStepNode } from './DagStepNode';
import {
  applyRunEvent,
  createInitialRunState,
  hydrateRunState,
  runStepsToFlow,
  type DagStepNodeData,
  type RunState,
  type StepView,
} from './run-state';

type LogFilter = 'all' | 'logs' | 'errors';

const ACTIVE_RUN_STATUSES = new Set<RunStatus>(['queued', 'running', 'paused', 'pausing']);
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
    requestAnimationFrame(() => fitView({ padding: 0.2, duration: 200 }));
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
  onNodeClick,
}: {
  runState: RunState | null;
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

        const current = node.data;
        if (
          current.label === step.name &&
          current.plugin === step.plugin &&
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
            plugin: step.plugin,
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

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-panel border-r border-line">
      <h2 className="shrink-0 text-xs font-medium text-faint uppercase tracking-wider px-6 pt-6 pb-4">
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
          fitViewKey={structureKey}
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
  const [subscribeKey, setSubscribeKey] = useState<string | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  const handleEvent = useCallback((event: Parameters<typeof applyRunEvent>[1]) => {
    setRunState((prev) => {
      if (!prev) return prev;
      const next = applyRunEvent(prev, event);
      setRecordStatus(next.status);
      return next;
    });
  }, []);

  const handleDone = useCallback((result: WorkflowRunResultSerialized) => {
    setRecordStatus(terminalStatusFromResult(result));
    setSubscribeKey(null);
  }, []);

  const { status: wsStatus } = useWorkflowRun({
    runId,
    autoSubscribe: subscribeKey === runId,
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
        setSubscribeKey(runId!);
      } else {
        setSubscribeKey(null);
      }
    }

    load().catch((e) => {
      setRunState(createInitialRunState(runId!, undefined));
      setSubscribeKey(null);
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
        setSubscribeKey(null);
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
      setSubscribeKey(runId);
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

  const filteredLogs = (runState?.logs ?? []).filter((log) => {
    if (logFilter === 'logs') return log.kind === 'log' || log.kind === 'stream';
    if (logFilter === 'errors') {
      return (
        log.kind === 'error' ||
        log.eventType?.includes('failed') ||
        (log.kind === 'stream' && log.stream === 'stderr') ||
        log.level === 'error'
      );
    }
    return true;
  });

  const meta = RUN_STATUS_META[recordStatus] ?? RUN_STATUS_META.running;
  const canCancel = CANCELLABLE_STATUSES.has(recordStatus);
  const canPause = PAUSABLE_STATUSES.has(recordStatus);
  const canResume = RESUMABLE_STATUSES.has(recordStatus);
  const isActiveRun = ACTIVE_RUN_STATUSES.has(recordStatus);

  return (
    <div className="flex flex-col h-screen bg-canvas">
      <header className="shrink-0 bg-surface border-b border-line px-6 py-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <Link to="/runs" className="text-sm text-muted hover:text-ink">
              ← 运行列表
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
          <div className="flex items-center gap-6 text-sm">
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

      <div className="flex-1 flex min-h-0">
        <RunDagPanel runState={runState} onNodeClick={setDrawerStep} />

        <div className="w-[560px] shrink-0 flex flex-col bg-surface">
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
          <div className="flex-1 overflow-auto p-4 font-mono text-xs bg-panel">
            {filteredLogs.map((log) =>
              log.kind === 'stream' ? (
                <pre
                  key={log.id}
                  className={`whitespace-pre-wrap break-words ${
                    log.stream === 'stderr' ? 'text-failed' : 'text-ink'
                  }`}
                >
                  {log.message}
                </pre>
              ) : (
                <div key={log.id} className="log-line">
                  <span className="text-faint">{log.ts}</span>{' '}
                  <span className={log.kind === 'log' ? 'text-running' : 'text-muted'}>
                    [{log.eventType ?? log.kind}]
                  </span>{' '}
                  {log.stepId && (
                    <span className="text-brand">
                      {log.stepName ?? runState?.steps[log.stepId]?.name ?? log.stepId}
                    </span>
                  )}{' '}
                  <span className="text-ink">{log.message}</span>
                </div>
              ),
            )}
            {isActiveRun && (
              <div ref={logEndRef} className="cursor-blink text-faint">
                等待事件…
              </div>
            )}
          </div>
        </div>
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
              <span className="text-muted">插件:</span> {drawerStep.plugin}
            </div>
            <StatusBadge status={drawerStep.status} size="md" />
            {drawerStep.status === 'failed' && (
              <>
                {drawerStep.failureKind && (
                  <div>
                    <span className="text-muted">失败类型:</span> {drawerStep.failureKind}
                  </div>
                )}
                {drawerStep.error && (
                  <pre className="bg-panel p-3 rounded-ctrl text-xs overflow-auto">
                    {JSON.stringify(drawerStep.error, null, 2)}
                  </pre>
                )}
                {drawerStep.pluginResult != null && (
                  <pre className="bg-panel p-3 rounded-ctrl text-xs overflow-auto">
                    {JSON.stringify(drawerStep.pluginResult, null, 2)}
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
