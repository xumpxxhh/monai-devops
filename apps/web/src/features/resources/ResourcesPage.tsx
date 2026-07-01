import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { resourcesApi } from '../../shared/api/misc';
import type { QueueStatus, ResourceSlot } from '../../shared/types';

export default function ResourcesPage() {
  const [resources, setResources] = useState<ResourceSlot[]>([]);
  const [queue, setQueue] = useState<QueueStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([resourcesApi.list(), resourcesApi.queue()])
      .then(([res, q]) => {
        setResources(res);
        setQueue(q);
      })
      .catch((e) => {
        toast.error(e instanceof Error ? e.message : '加载资源数据失败');
      })
      .finally(() => setLoading(false));

    const timer = setInterval(() => {
      resourcesApi
        .queue()
        .then(setQueue)
        .catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  const byType = queue?.byType ?? {};

  return (
    <div>
      <h1 className="text-xl font-semibold mb-6">资源与调度</h1>

      {loading ? (
        <p className="text-muted text-sm">加载中…</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-surface rounded-card border border-line shadow-card p-5">
            <h2 className="text-sm font-medium mb-4">资源池</h2>
            <div className="space-y-3">
              {resources.map((slot) => (
                <div
                  key={slot.id}
                  className="flex items-center justify-between p-3 rounded-ctrl bg-panel border border-line-soft"
                >
                  <div>
                    <div className="text-sm font-medium">{slot.name}</div>
                    <div className="text-xs text-faint font-mono">
                      {slot.id} · {slot.type}
                    </div>
                  </div>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-pill ${slot.status === 'available' ? 'bg-completed/10 text-completed' : 'bg-running/10 text-running'}`}
                  >
                    {slot.status}
                  </span>
                </div>
              ))}
              {resources.length === 0 && <p className="text-sm text-muted">暂无资源槽位</p>}
            </div>
          </div>

          <div className="bg-surface rounded-card border border-line shadow-card p-5">
            <h2 className="text-sm font-medium mb-4">调度队列</h2>
            <div className="space-y-4">
              {Object.entries(byType).map(([type, stat]) => {
                const total = stat.queueLength + stat.runningCount;
                const usedPct = total > 0 ? (stat.runningCount / total) * 100 : 0;
                return (
                  <div key={type}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="font-medium">{type}</span>
                      <span className="text-muted text-xs">
                        排队 {stat.queueLength} · 运行 {stat.runningCount}
                      </span>
                    </div>
                    <div className="h-2 rounded-pill bg-raised overflow-hidden">
                      <div className="h-full bg-running" style={{ width: `${usedPct}%` }} />
                    </div>
                  </div>
                );
              })}
              {Object.keys(byType).length === 0 && <p className="text-sm text-muted">队列为空</p>}
            </div>

            <div className="mt-6 p-4 rounded-ctrl bg-brand-soft border border-brand/20">
              <p className="text-sm text-muted">
                步骤在 <code className="text-xs bg-panel px-1 rounded">step:queued</code>{' '}
                时会等待资源槽位。 可在{' '}
                <Link to="/runs" className="text-brand hover:underline">
                  运行详情
                </Link>{' '}
                中查看排队步骤并下钻排障。
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
