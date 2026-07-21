import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { runsApi } from '../../shared/api/runs';
import { notifyRunsChanged } from '../../shared/api/runs-events';
import type { RunRecord, RunStatus } from '../../shared/types';
import { RUN_STATUS_META } from '../../shared/types/status';
import { ProgressBar } from '../../shared/status/ProgressBar';
import { EmptyState } from '../../shared/ui/EmptyState';
import { Input, Select } from '../../shared/ui/form';
import { Modal } from '../../shared/ui/Modal';

const ACTIVE_RUN_STATUSES = new Set<RunStatus>(['queued', 'running', 'paused', 'pausing']);

export default function RunsListPage() {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      setLoading(true);
      try {
        const res = await runsApi.list({
          status: statusFilter || undefined,
          search: search || undefined,
          pageSize: 50,
        });
        setRuns(res.items);
      } catch (e) {
        if (!opts?.silent) {
          toast.error(e instanceof Error ? e.message : '加载运行列表失败');
        }
      } finally {
        setLoading(false);
      }
    },
    [statusFilter, search],
  );

  useEffect(() => {
    // 列表轮询：在 effect 中触发数据拉取
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 合法的客户端数据同步
    void load();
    const timer = setInterval(() => void load({ silent: true }), 5000);
    return () => clearInterval(timer);
  }, [load]);

  const handleDelete = async () => {
    if (!deleteId) return;
    setDeleting(true);
    try {
      await runsApi.remove(deleteId);
      setDeleteId(null);
      toast.success('运行记录已删除');
      setRuns((prev) => prev.filter((r) => r.runId !== deleteId));
      notifyRunsChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除运行记录失败');
    } finally {
      setDeleting(false);
    }
  };

  const formatTime = (iso?: string) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold">运行列表</h1>
        <div className="flex items-center gap-3">
          <Input
            type="search"
            placeholder="搜索 runId / 工作流…"
            className="w-64 bg-surface"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="搜索运行"
          />
          <Select
            value={statusFilter || '__all__'}
            onValueChange={(v) => setStatusFilter(v === '__all__' ? '' : v)}
            triggerClassName="w-48 bg-surface"
            aria-label="筛选状态"
            options={[
              { value: '__all__', label: '全部状态' },
              { value: 'running', label: '运行中' },
              { value: 'queued', label: '排队' },
              { value: 'finished', label: '已完成' },
              { value: 'failed', label: '失败' },
              { value: 'cancelled', label: '已取消' },
            ]}
          />
        </div>
      </div>

      {loading && runs.length === 0 ? (
        <p className="text-muted text-sm">加载中…</p>
      ) : runs.length === 0 ? (
        <EmptyState
          title="暂无运行记录"
          description="在工作流编排器中创建并运行工作流后，记录将显示在这里。"
          action={
            <Link to="/workflows/new" className="text-sm text-brand hover:underline">
              新建工作流 →
            </Link>
          }
        />
      ) : (
        <div className="bg-surface rounded-card border border-line shadow-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-faint uppercase tracking-wider">
                <th className="px-4 py-3 font-medium">状态</th>
                <th className="px-4 py-3 font-medium">工作流</th>
                <th className="px-4 py-3 font-medium">Run ID</th>
                <th className="px-4 py-3 font-medium">开始时间</th>
                <th className="px-4 py-3 font-medium w-48">进度</th>
                <th className="px-4 py-3 font-medium w-40">操作</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const meta = RUN_STATUS_META[run.status] ?? RUN_STATUS_META.queued;
                const canDelete = !ACTIVE_RUN_STATUSES.has(run.status);
                const counts = {
                  completed: run.counts.completed,
                  running:
                    run.status === 'running'
                      ? Math.max(
                          0,
                          run.counts.total -
                            run.counts.completed -
                            run.counts.failed -
                            run.counts.skipped,
                        )
                      : 0,
                  queued: run.status === 'queued' ? 1 : 0,
                  failed: run.counts.failed,
                  skipped: run.counts.skipped,
                  total: run.counts.total,
                };
                return (
                  <tr key={run.runId} className="border-b border-line-soft hover:bg-raised/50">
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1.5 text-xs ${meta.color}`}>
                        <span className={`w-2 h-2 rounded-full ${meta.dot}`} />
                        {meta.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-medium">
                      {run.workflowSnapshot?.name ?? run.workflowId}
                    </td>
                    <td className="px-4 py-3 font-mono text-muted">
                      <Link to={`/runs/${run.runId}`} className="hover:text-brand">
                        {run.runId.slice(0, 8)}…
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-muted">
                      {formatTime(run.startedAt ?? run.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <ProgressBar {...counts} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Link
                          to={`/runs/${run.runId}`}
                          className=" whitespace-nowrap inline-flex items-center h-8 px-3 rounded-ctrl border border-line hover:bg-raised text-xs font-medium"
                        >
                          查看详情
                        </Link>
                        {canDelete && (
                          <button
                            type="button"
                            onClick={() => setDeleteId(run.runId)}
                            className=" whitespace-nowrap inline-flex items-center h-8 px-3 rounded-ctrl border border-line text-failed hover:bg-failed/10 text-xs font-medium"
                          >
                            删除
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={!!deleteId}
        onOpenChange={(o) => !o && !deleting && setDeleteId(null)}
        title="确认删除"
        footer={
          <>
            <button
              type="button"
              className="px-4 py-2 text-sm rounded-ctrl border border-line"
              disabled={deleting}
              onClick={() => setDeleteId(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="px-4 py-2 text-sm rounded-ctrl bg-failed text-white disabled:opacity-60"
              disabled={deleting}
              onClick={handleDelete}
            >
              {deleting ? '删除中…' : '删除'}
            </button>
          </>
        }
      >
        确定要删除运行 <span className="font-mono">{deleteId?.slice(0, 8)}…</span>{' '}
        吗？此操作不可恢复。
      </Modal>
    </div>
  );
}
