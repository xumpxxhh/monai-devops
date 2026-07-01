import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faEllipsisVertical, faPlay, faPlus } from '@fortawesome/free-solid-svg-icons';
import type { WorkflowDefinition } from '@monai-devops/core-engine';
import { workflowsApi } from '../../shared/api/workflows';
import { EmptyState } from '../../shared/ui/EmptyState';
import { Input } from '../../shared/ui/form';
import { Modal } from '../../shared/ui/Modal';

export default function WorkflowsListPage() {
  const navigate = useNavigate();
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await workflowsApi.list({ search: search || undefined, pageSize: 50 });
      setWorkflows(res.items);
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
  }, [load]);

  const handleRun = async (id: string) => {
    const { runId } = await workflowsApi.run(id);
    navigate(`/runs/${runId}`);
  };

  const handleCopy = async (wf: WorkflowDefinition) => {
    const copy: WorkflowDefinition = {
      ...wf,
      id: `${wf.id}-copy-${Date.now()}`,
      name: `${wf.name} (副本)`,
    };
    await workflowsApi.create(copy);
    load();
  };

  const handleExport = (wf: WorkflowDefinition) => {
    const blob = new Blob([JSON.stringify(wf, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${wf.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    await workflowsApi.remove(deleteId);
    setDeleteId(null);
    load();
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold">工作流</h1>
        <div className="flex items-center gap-3">
          <Input
            type="search"
            placeholder="搜索工作流…"
            className="w-56 bg-surface"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="搜索工作流"
          />
          <Link
            to="/workflows/new"
            className="inline-flex items-center gap-2 h-9 px-4 rounded-ctrl bg-brand text-white text-sm font-medium hover:bg-brand-hover"
          >
            <FontAwesomeIcon icon={faPlus} />
            新建
          </Link>
        </div>
      </div>

      {loading && workflows.length === 0 ? (
        <p className="text-muted text-sm">加载中…</p>
      ) : workflows.length === 0 ? (
        <EmptyState
          title="还没有工作流"
          description="创建第一个工作流，开始编排 DAG 并运行。"
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
                <th className="px-4 py-3 font-medium">名称</th>
                <th className="px-4 py-3 font-medium">ID</th>
                <th className="px-4 py-3 font-medium">步骤数</th>
                <th className="px-4 py-3 font-medium w-32">操作</th>
              </tr>
            </thead>
            <tbody>
              {workflows.map((wf) => (
                <tr key={wf.id} className="border-b border-line-soft hover:bg-raised/50">
                  <td className="px-4 py-3 font-medium">
                    <Link to={`/workflows/${wf.id}/edit`} className="hover:text-brand">
                      {wf.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 font-mono text-muted text-xs">{wf.id}</td>
                  <td className="px-4 py-3 text-muted">{wf.steps.length}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => handleRun(wf.id)}
                        className="p-2 rounded-ctrl hover:bg-brand-soft text-brand"
                        title="运行"
                      >
                        <FontAwesomeIcon icon={faPlay} />
                      </button>
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => setMenuOpen(menuOpen === wf.id ? null : wf.id)}
                          className="p-2 rounded-ctrl hover:bg-raised text-muted"
                        >
                          <FontAwesomeIcon icon={faEllipsisVertical} />
                        </button>
                        {menuOpen === wf.id && (
                          <div className="absolute right-0 top-full mt-1 z-10 bg-surface border border-line rounded-ctrl shadow-pop py-1 min-w-[120px]">
                            <button
                              type="button"
                              className="w-full text-left px-3 py-1.5 text-sm hover:bg-raised"
                              onClick={() => {
                                handleCopy(wf);
                                setMenuOpen(null);
                              }}
                            >
                              复制
                            </button>
                            <button
                              type="button"
                              className="w-full text-left px-3 py-1.5 text-sm hover:bg-raised"
                              onClick={() => {
                                handleExport(wf);
                                setMenuOpen(null);
                              }}
                            >
                              导出 JSON
                            </button>
                            <button
                              type="button"
                              className="w-full text-left px-3 py-1.5 text-sm hover:bg-raised text-failed"
                              onClick={() => {
                                setDeleteId(wf.id);
                                setMenuOpen(null);
                              }}
                            >
                              删除
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={!!deleteId}
        onOpenChange={(o) => !o && setDeleteId(null)}
        title="确认删除"
        footer={
          <>
            <button
              type="button"
              className="px-4 py-2 text-sm rounded-ctrl border border-line"
              onClick={() => setDeleteId(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="px-4 py-2 text-sm rounded-ctrl bg-failed text-white"
              onClick={handleDelete}
            >
              删除
            </button>
          </>
        }
      >
        确定要删除工作流 <span className="font-mono">{deleteId}</span> 吗？此操作不可恢复。
      </Modal>
    </div>
  );
}
