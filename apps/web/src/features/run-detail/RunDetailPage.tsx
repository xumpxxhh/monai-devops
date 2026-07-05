import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCopy, faBan } from '@fortawesome/free-solid-svg-icons';
import { runsApi } from '../../shared/api/runs';
import { useWorkflowRun } from '../../shared/hooks/useWorkflowRun';
import { StatusBadge } from '../../shared/ui/StatusBadge';
import { ProgressBar } from '../../shared/ui/ProgressBar';
import { TabsBar } from '../../shared/ui/Tabs';
import { Drawer } from '../../shared/ui/Drawer';
import { Checkbox } from '../../shared/ui/form';
import { WsPill } from '../../shared/ui/WsPill';
import { RUN_STATUS_META } from '../../shared/types/status';
import {
  applyRunEvent,
  createInitialRunState,
  hydrateRunState,
  type RunState,
  type StepView,
} from './run-state';

type LogFilter = 'all' | 'logs' | 'errors';

function DagNodeView({ step, onClick }: { step: StepView; onClick: () => void }) {
  const ringClass = `node-${step.status}`;
  const isRunning = step.status === 'running';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-4 py-3 rounded-ctrl bg-surface border border-line text-left min-w-[120px] ${ringClass} ${isRunning ? 'running-ring' : ''}`}
    >
      <div className="text-sm font-medium truncate">{step.name}</div>
      <div className="text-xs text-faint font-mono">{step.id}</div>
      <StatusBadge status={step.status} />
    </button>
  );
}

export default function RunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const [runState, setRunState] = useState<RunState | null>(null);
  const [recordStatus, setRecordStatus] = useState<string>('running');
  const [logFilter, setLogFilter] = useState<LogFilter>('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const [paused, setPaused] = useState(false);
  const [drawerStep, setDrawerStep] = useState<StepView | null>(null);
  const [wsBanner, setWsBanner] = useState('');
  const [subscribeKey, setSubscribeKey] = useState<string | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  const handleEvent = useCallback(
    (event: Parameters<typeof applyRunEvent>[1]) => {
      if (paused) return;
      setRunState((prev) => (prev ? applyRunEvent(prev, event) : prev));
    },
    [paused],
  );

  const handleDone = useCallback(() => {
    setRecordStatus('finished');
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
      setRunState(hydrated);

      if (record.status === 'running' || record.status === 'queued') {
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

  const lastLogMessage = runState?.logs.at(-1)?.message;

  useEffect(() => {
    if (autoScroll && !paused) {
      logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [runState?.logs.length, lastLogMessage, autoScroll, paused]);

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
  const steps = runState ? Object.values(runState.steps) : [];

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
          <div className="flex items-center gap-3">
            <WsPill status={wsStatus} />
            <button
              type="button"
              disabled
              title="内核 AbortSignal 未实现"
              className="inline-flex items-center gap-2 h-8 px-3 rounded-ctrl text-sm border border-line text-faint cursor-not-allowed opacity-60"
            >
              <FontAwesomeIcon icon={faBan} />
              取消运行
            </button>
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
        <div className="flex-1 p-6 overflow-auto bg-panel border-r border-line">
          <h2 className="text-xs font-medium text-faint uppercase tracking-wider mb-4">DAG 状态</h2>
          <div className="flex flex-wrap gap-6 items-start">
            {steps.map((step) => (
              <DagNodeView key={step.id} step={step} onClick={() => setDrawerStep(step)} />
            ))}
          </div>
          {runState && runState.edges.length > 0 && (
            <p className="text-xs text-faint mt-6">
              依赖边: {runState.edges.map((e) => `${e.from}→${e.to}`).join(', ')}
            </p>
          )}
        </div>

        <div className="w-[480px] shrink-0 flex flex-col bg-surface">
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
                onClick={() => setPaused((p) => !p)}
                className="px-2 py-1 rounded-ctrl hover:bg-raised text-muted"
              >
                {paused ? '继续' : '暂停'}
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
            {recordStatus === 'running' && (
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
