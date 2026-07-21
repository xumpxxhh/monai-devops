import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { pluginsApi } from '../../shared/api/misc';
import type { ExecutionResultSerialized, PluginInfo } from '../../shared/types';
import { StatusBadge } from '../../shared/status/StatusBadge';
import { EmptyState } from '../../shared/ui/EmptyState';
import {
  PluginConfigForm,
  type PluginConfigFormHandle,
  preloadPluginConfigSchemas,
} from '../../shared/plugins';
import { appendPluginLogEvent, type LogLine } from '../run-detail/run-state';

export default function PluginsPage() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [selected, setSelected] = useState<PluginInfo | null>(null);
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [dryRunResult, setDryRunResult] = useState<ExecutionResultSerialized | null>(null);
  const [dryRunError, setDryRunError] = useState('');
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [formReady, setFormReady] = useState(false);
  const configFormRef = useRef<PluginConfigFormHandle>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const lastLogMessage = logs.at(-1)?.message;

  useEffect(() => {
    if (running) {
      logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs.length, lastLogMessage, running]);

  useEffect(() => {
    void Promise.all([pluginsApi.list(), preloadPluginConfigSchemas()])
      .then(([list]) => {
        setPlugins(list);
        if (list[0]) setSelected(list[0]);
      })
      .catch((e) => {
        toast.error(e instanceof Error ? e.message : '加载插件列表失败');
      });
  }, []);

  const handleDryRun = async () => {
    if (!selected) return;

    const validation = configFormRef.current?.validate();
    if (!validation || !validation.ok) {
      setDryRunError('请完善配置后再试运行');
      return;
    }

    setRunning(true);
    setDryRunError('');
    setDryRunResult(null);
    setLogs([]);
    try {
      const result = await pluginsApi.dryRun(selected.name, validation.config, {
        onLog: (event) => setLogs((prev) => appendPluginLogEvent(prev, event)),
      });
      setDryRunResult(result);
      toast.success('试运行完成');
    } catch (e) {
      const message = e instanceof Error ? e.message : '试运行失败';
      setDryRunError(message);
      toast.error(message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      <h1 className="text-xl font-semibold mb-6">插件管理</h1>

      {plugins.length === 0 ? (
        <EmptyState title="暂无已注册插件" description="请确认后端 Engine 已加载插件。" />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1 bg-surface rounded-card border border-line shadow-card overflow-hidden">
            <div className="px-4 py-3 border-b border-line text-xs text-faint uppercase tracking-wider">
              已注册插件
            </div>
            <ul>
              {plugins.map((p) => (
                <li key={p.name}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(p);
                      setConfig({});
                      setFormReady(false);
                      setDryRunResult(null);
                      setDryRunError('');
                      setLogs([]);
                    }}
                    className={`w-full text-left px-4 py-3 border-b border-line-soft hover:bg-raised ${selected?.name === p.name ? 'bg-brand-soft' : ''}`}
                  >
                    <div className="font-medium">{p.name}</div>
                    <div className="text-xs text-faint">v{p.version}</div>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="lg:col-span-2 space-y-4">
            {selected && (
              <>
                <div className="bg-surface rounded-card border border-line shadow-card p-5">
                  <h2 className="text-lg font-semibold mb-1">{selected.name}</h2>
                  <p className="text-sm text-muted mb-4">{selected.description ?? '无描述'}</p>
                  <p className="text-xs text-faint font-mono">version: {selected.version}</p>
                </div>

                <div className="bg-surface rounded-card border border-line shadow-card p-5">
                  <h3 className="text-sm font-medium mb-3">单步试运行</h3>
                  <div className="mb-4">
                    <PluginConfigForm
                      ref={configFormRef}
                      key={selected.name}
                      pluginName={selected.name}
                      value={config}
                      onChange={setConfig}
                      onReadyChange={setFormReady}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={handleDryRun}
                    disabled={running || !formReady}
                    className="h-9 px-4 rounded-ctrl bg-brand text-white text-sm font-medium hover:bg-brand-hover disabled:opacity-50"
                  >
                    {running ? '运行中…' : '试运行'}
                  </button>

                  {(running || logs.length > 0) && (
                    <div className="mt-4 p-3 rounded-ctrl bg-panel font-mono text-xs max-h-64 overflow-auto">
                      {logs.map((log) =>
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
                              <span className="text-brand">{log.stepName ?? log.stepId}</span>
                            )}{' '}
                            <span className="text-ink">{log.message}</span>
                          </div>
                        ),
                      )}
                      {running && (
                        <div ref={logEndRef} className="cursor-blink text-faint">
                          等待日志…
                        </div>
                      )}
                    </div>
                  )}

                  {dryRunError && <p className="text-sm text-failed mt-3">{dryRunError}</p>}

                  {dryRunResult && (
                    <div className="mt-4 p-4 rounded-ctrl bg-panel border border-line">
                      <div className="flex items-center gap-2 mb-2">
                        <StatusBadge status={dryRunResult.status} size="md" />
                        <span className="text-sm text-muted">stepId: {dryRunResult.stepId}</span>
                      </div>
                      <pre className="text-xs font-mono overflow-auto">
                        {JSON.stringify(dryRunResult, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
