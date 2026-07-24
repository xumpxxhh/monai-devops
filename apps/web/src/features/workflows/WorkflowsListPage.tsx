import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faChevronRight,
  faEllipsisVertical,
  faPenToSquare,
  faPlay,
  faPlus,
} from '@fortawesome/free-solid-svg-icons';
import {
  getStepKind,
  isPluginStep,
  isSetStateStep,
  isWorkflowRefStep,
  StepKinds,
  type WorkflowDefinition,
  type WorkflowStep,
} from '@monai-devops/core-engine';
import { workflowsApi, type WorkflowDraft } from '../../shared/api/workflows';
import { DropdownMenu } from '../../shared/ui/DropdownMenu';
import { EmptyState } from '../../shared/ui/EmptyState';
import { Input } from '../../shared/ui/form';
import { Modal } from '../../shared/ui/Modal';
import type { WorkflowImportRecord, WorkflowRecord } from '../../shared/types';

function cloneStepToDraft(step: WorkflowStep, clientRef: string, refByStepId: Map<string, string>) {
  const base = {
    clientRef,
    name: step.name,
    dependsOn: step.dependsOn?.map((dep) => refByStepId.get(dep) ?? dep),
    priority: step.priority,
    condition: step.condition,
  };

  if (isSetStateStep(step)) {
    return { ...base, kind: StepKinds.SET_STATE, patch: structuredClone(step.patch) };
  }
  if (isWorkflowRefStep(step)) {
    // 副本工作流尚未有自己的 imports；跳过 workflow 步骤，避免无效 importId
    return null;
  }
  if (isPluginStep(step)) {
    return {
      ...base,
      kind: StepKinds.PLUGIN,
      plugin: step.plugin,
      config: structuredClone(step.config),
    };
  }
  return {
    ...base,
    kind: StepKinds.PLUGIN,
    plugin: '',
    config: {},
  };
}

function WorkflowImportsContent({ parentId }: { parentId: string }) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [imports, setImports] = useState<WorkflowImportRecord[]>([]);

  useEffect(() => {
    let cancelled = false;
    void workflowsApi
      .listImports(parentId)
      .then((rows) => {
        if (!cancelled) setImports(rows);
      })
      .catch((e) => {
        if (!cancelled) {
          toast.error(e instanceof Error ? e.message : '加载子工作流失败');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [parentId]);

  return (
    <div className="px-4 py-3">
      {loading ? (
        <p className="text-xs text-faint">加载子工作流…</p>
      ) : imports.length === 0 ? (
        <p className="text-xs text-faint">尚未导入子工作流</p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-faint">
              <th className="py-1 font-medium">子工作流</th>
              <th className="py-1 font-medium">模式</th>
              <th className="py-1 font-medium">更新时间</th>
              <th className="py-1 font-medium w-28">操作</th>
            </tr>
          </thead>
          <tbody>
            {imports.map((row) => (
              <tr key={row.id} className="border-t border-line-soft">
                <td className="py-2">
                  <div className="font-medium">{row.childWorkflowName ?? row.childWorkflowId}</div>
                  <div className="font-mono text-faint">{row.childWorkflowId}</div>
                </td>
                <td className="py-2">{row.mode}</td>
                <td className="py-2 text-muted">
                  {row.childWorkflowUpdatedAt
                    ? new Date(row.childWorkflowUpdatedAt).toLocaleString()
                    : '—'}
                </td>
                <td className="py-2">
                  {row.mode === 'copy' ? (
                    <button
                      type="button"
                      className="text-brand hover:underline"
                      onClick={() => navigate(`/workflows/${row.childWorkflowId}/edit`)}
                    >
                      编辑
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="text-muted hover:underline"
                      onClick={() => navigate(`/workflows/${row.childWorkflowId}/edit`)}
                    >
                      查看
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function CollapsibleImportsRow({
  expanded,
  parentId,
  onCollapsed,
}: {
  expanded: boolean;
  parentId: string;
  onCollapsed: () => void;
}) {
  return (
    <tr className="bg-raised/40">
      <td colSpan={5} className="p-0">
        <div
          className="nested-log-collapse"
          data-expanded={expanded ? 'true' : 'false'}
          onTransitionEnd={(e) => {
            if (e.propertyName === 'grid-template-rows' && !expanded) onCollapsed();
          }}
        >
          <div className="nested-log-collapse-inner">
            <WorkflowImportsContent parentId={parentId} />
          </div>
        </div>
      </td>
    </tr>
  );
}

export default function WorkflowsListPage() {
  const navigate = useNavigate();
  const [workflows, setWorkflows] = useState<WorkflowRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [mountedIds, setMountedIds] = useState<Set<string>>(() => new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await workflowsApi.list({ search: search || undefined, pageSize: 50 });
      setWorkflows(res.items);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载工作流列表失败');
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
  }, [load]);

  const handleRun = async (id: string) => {
    try {
      const { runId } = await workflowsApi.run(id);
      navigate(`/runs/${runId}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '运行工作流失败');
    }
  };

  const handleCopy = async (wf: WorkflowDefinition) => {
    const refByStepId = new Map(wf.steps.map((step, i) => [step.id, `copy-${i}`]));
    const steps = wf.steps
      .map((step, i) => cloneStepToDraft(step, `copy-${i}`, refByStepId))
      .filter((step): step is NonNullable<typeof step> => step !== null);

    if (steps.length === 0) {
      toast.warning('副本中没有可复制的步骤（workflow 引用步骤需重新导入）');
      return;
    }

    const skippedWorkflow = wf.steps.some((s) => getStepKind(s) === StepKinds.WORKFLOW);
    const copy: WorkflowDraft = {
      name: `${wf.name} (副本)`,
      ...(wf.stateSchema
        ? { stateSchema: structuredClone(wf.stateSchema) as Record<string, unknown> }
        : {}),
      steps,
    };
    try {
      await workflowsApi.create(copy);
      toast.success(
        skippedWorkflow ? '工作流已复制（子工作流引用步骤已跳过，请重新导入）' : '工作流已复制',
      );
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '复制工作流失败');
    }
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
    try {
      await workflowsApi.remove(deleteId);
      setDeleteId(null);
      toast.success('工作流已删除');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除工作流失败');
    }
  };

  const toggleExpand = (id: string) => {
    if (expandedIds.has(id)) {
      setExpandedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      return;
    }

    setMountedIds((prev) => new Set(prev).add(id));
    requestAnimationFrame(() => {
      setExpandedIds((prev) => new Set(prev).add(id));
    });
  };

  const unmountImports = (id: string) => {
    setMountedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold">工作流</h1>
        <div className="flex items-center gap-3">
          <Input
            type="search"
            placeholder="搜索工作流…"
            className="w-64 bg-surface"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="搜索工作流"
          />
          <Link
            to="/workflows/new"
            className="inline-flex w-32 items-center gap-2 h-9 px-4 rounded-ctrl bg-brand text-white text-sm font-medium hover:bg-brand-hover"
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
                <th className="px-4 py-3 font-medium w-10" />
                <th className="px-4 py-3 font-medium">名称</th>
                <th className="px-4 py-3 font-medium">ID</th>
                <th className="px-4 py-3 font-medium">步骤数</th>
                <th className="px-4 py-3 font-medium w-40">操作</th>
              </tr>
            </thead>
            <tbody>
              {workflows.map((record) => {
                const expanded = expandedIds.has(record.id);
                const mounted = mountedIds.has(record.id);
                return (
                  <Fragment key={record.id}>
                    <tr className="border-b border-line-soft hover:bg-raised/50">
                      <td className="px-2 py-3">
                        <button
                          type="button"
                          className="p-1.5 rounded-ctrl hover:bg-raised text-muted"
                          aria-label={expanded ? '收起子工作流' : '展开子工作流'}
                          aria-expanded={expanded}
                          onClick={() => toggleExpand(record.id)}
                        >
                          <FontAwesomeIcon
                            icon={faChevronRight}
                            className="nested-log-chevron w-3"
                            data-expanded={expanded ? 'true' : 'false'}
                          />
                        </button>
                      </td>
                      <td className="px-4 py-3 font-medium">
                        <Link to={`/workflows/${record.id}/edit`} className="hover:text-brand">
                          {record.definition.name}
                        </Link>
                      </td>
                      <td className="px-4 py-3 font-mono text-muted text-xs">{record.id}</td>
                      <td className="px-4 py-3 text-muted">{record.definition.steps?.length}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => void handleRun(record.id)}
                            className="p-2 rounded-ctrl hover:bg-brand-soft text-brand"
                            title="运行"
                          >
                            <FontAwesomeIcon icon={faPlay} />
                          </button>
                          <Link
                            to={`/workflows/${record.id}/edit`}
                            className="p-2 rounded-ctrl hover:bg-raised text-muted"
                            title="编辑"
                          >
                            <FontAwesomeIcon icon={faPenToSquare} />
                          </Link>
                          <DropdownMenu
                            trigger={
                              <button
                                type="button"
                                className="p-2 rounded-ctrl hover:bg-raised text-muted"
                                aria-label="更多操作"
                              >
                                <FontAwesomeIcon icon={faEllipsisVertical} />
                              </button>
                            }
                            items={[
                              {
                                label: '编辑',
                                onSelect: () => navigate(`/workflows/${record.id}/edit`),
                              },
                              {
                                label: '复制',
                                onSelect: () => void handleCopy(record.definition),
                              },
                              {
                                label: '导出 JSON',
                                onSelect: () => handleExport(record.definition),
                              },
                              {
                                label: '删除',
                                onSelect: () => setDeleteId(record.id),
                                destructive: true,
                              },
                            ]}
                          />
                        </div>
                      </td>
                    </tr>
                    {mounted ? (
                      <CollapsibleImportsRow
                        expanded={expanded}
                        parentId={record.id}
                        onCollapsed={() => unmountImports(record.id)}
                      />
                    ) : null}
                  </Fragment>
                );
              })}
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
              onClick={() => void handleDelete()}
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
