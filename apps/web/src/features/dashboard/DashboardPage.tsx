import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { statsApi } from '../../shared/api/misc';
import { runsApi } from '../../shared/api/runs';
import type { RunRecord, StatsOverview } from '../../shared/types';
import { RUN_STATUS_META } from '../../shared/types/status';
import { ProgressBar } from '../../shared/status/ProgressBar';

function KpiCard({
  label,
  value,
  sub,
  href,
}: {
  label: string;
  value: string | number;
  sub?: string;
  href?: string;
}) {
  const inner = (
    <div className="bg-surface rounded-card border border-line shadow-card p-5 hover:border-brand/30 transition-colors h-full">
      <div className="text-xs text-faint uppercase tracking-wider mb-2">{label}</div>
      <div className="text-2xl font-semibold text-ink">{value}</div>
      <div className="text-xs text-muted mt-1 min-h-[1.25rem]">{sub ?? ''}</div>
    </div>
  );
  return href ? (
    <Link to={href} className="block h-full">
      {inner}
    </Link>
  ) : (
    inner
  );
}

export default function DashboardPage() {
  const [stats, setStats] = useState<StatsOverview | null>(null);
  const [recentRuns, setRecentRuns] = useState<RunRecord[]>([]);

  useEffect(() => {
    statsApi
      .overview()
      .then(setStats)
      .catch((e) => {
        toast.error(e instanceof Error ? e.message : '加载统计数据失败');
      });
    runsApi
      .list({ pageSize: 5 })
      .then((r) => setRecentRuns(r.items))
      .catch((e) => {
        toast.error(e instanceof Error ? e.message : '加载近期运行失败');
      });

    const timer = setInterval(() => {
      statsApi
        .overview()
        .then(setStats)
        .catch(() => {});
    }, 10000);
    return () => clearInterval(timer);
  }, []);

  const queueTotal = stats
    ? Object.values(stats.queue.byType).reduce((a, b) => a + b.queueLength, 0)
    : 0;

  return (
    <div>
      <h1 className="text-xl font-semibold mb-6">概览</h1>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <KpiCard label="进行中" value={stats?.activeRuns ?? '—'} href="/runs?status=running" />
        <KpiCard
          label="成功率"
          value={stats ? `${Math.round(stats.successRate * 100)}%` : '—'}
          sub={stats ? `已完成 ${stats.finishedRuns} · 失败 ${stats.failedRuns}` : undefined}
          href="/runs"
        />
        <KpiCard label="排队步骤" value={queueTotal} href="/resources" />
        <KpiCard label="插件数" value={stats?.pluginCount ?? '—'} href="/plugins" />
      </div>

      <div className="bg-surface rounded-card border border-line shadow-card overflow-hidden">
        <div className="px-5 py-4 border-b border-line flex items-center justify-between">
          <h2 className="text-sm font-medium">近期运行</h2>
          <Link to="/runs" className="text-xs text-brand hover:underline">
            查看全部 →
          </Link>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-faint uppercase tracking-wider">
              <th className="px-4 py-3 font-medium">状态</th>
              <th className="px-4 py-3 font-medium">工作流</th>
              <th className="px-4 py-3 font-medium">进度</th>
            </tr>
          </thead>
          <tbody>
            {recentRuns.map((run) => {
              const meta = RUN_STATUS_META[run.status] ?? RUN_STATUS_META.queued;
              return (
                <tr key={run.runId} className="border-b border-line-soft hover:bg-raised/50">
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1.5 text-xs ${meta.color}`}>
                      <span className={`w-2 h-2 rounded-full ${meta.dot}`} />
                      {meta.label}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <Link to={`/runs/${run.runId}`} className="font-medium hover:text-brand">
                      {run.workflowSnapshot?.name ?? run.workflowId}
                    </Link>
                  </td>
                  <td className="px-4 py-3 w-40">
                    <ProgressBar
                      completed={run.counts.completed}
                      running={run.status === 'running' ? 1 : 0}
                      queued={0}
                      failed={run.counts.failed}
                      skipped={run.counts.skipped}
                      total={run.counts.total}
                    />
                  </td>
                </tr>
              );
            })}
            {recentRuns.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-8 text-center text-muted text-sm">
                  暂无运行记录 ·{' '}
                  <Link to="/workflows/new" className="text-brand">
                    新建工作流
                  </Link>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
