import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { workflowsApi } from '../../shared/api/workflows';
import type { WorkflowImportMode, WorkflowImportRecord, WorkflowRecord } from '../../shared/types';
import { Field, Select } from '../../shared/ui/form';
import { Modal } from '../../shared/ui/Modal';

function copySourceNameFromImport(row: WorkflowImportRecord): string | null {
  if (row.mode !== 'copy' || !row.childWorkflowName) return null;
  const marker = '__copy__';
  const idx = row.childWorkflowName.lastIndexOf(marker);
  return idx > 0 ? row.childWorkflowName.slice(0, idx) : null;
}

export function ImportWorkflowModal({
  open,
  onOpenChange,
  parentWorkflowId,
  imports,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parentWorkflowId: string;
  imports: WorkflowImportRecord[];
  onImported: () => void;
}) {
  const [candidates, setCandidates] = useState<WorkflowRecord[]>([]);
  const [childWorkflowId, setChildWorkflowId] = useState('');
  const [mode, setMode] = useState<WorkflowImportMode>('reference');
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(false);

  const fetchKey = open ? parentWorkflowId : null;
  const [prevFetchKey, setPrevFetchKey] = useState(fetchKey);
  if (fetchKey !== prevFetchKey) {
    setPrevFetchKey(fetchKey);
    if (fetchKey !== null) setLoading(true);
  }

  const excludedSourceIds = useMemo(() => {
    const ids = new Set<string>();
    for (const row of imports) {
      if (row.mode === 'reference') {
        ids.add(row.childWorkflowId);
      }
    }
    return ids;
  }, [imports]);

  const importedCopySourceNames = useMemo(() => {
    const names = new Set<string>();
    for (const row of imports) {
      const sourceName = copySourceNameFromImport(row);
      if (sourceName) names.add(sourceName);
    }
    return names;
  }, [imports]);

  const availableCandidates = useMemo(
    () =>
      candidates.filter((item) => {
        if (item.id === parentWorkflowId) return false;
        if (excludedSourceIds.has(item.id)) return false;
        if (importedCopySourceNames.has(item.definition.name)) return false;
        return true;
      }),
    [candidates, parentWorkflowId, excludedSourceIds, importedCopySourceNames],
  );

  const selectedChildWorkflowId = availableCandidates.some((c) => c.id === childWorkflowId)
    ? childWorkflowId
    : '';

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void workflowsApi
      .list({ pageSize: 100 })
      .then((res) => {
        if (!cancelled) {
          setCandidates(res.items);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          toast.error(e instanceof Error ? e.message : '加载可选工作流失败');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, parentWorkflowId]);

  const handleSubmit = async () => {
    if (!selectedChildWorkflowId) {
      toast.warning('请选择要导入的工作流');
      return;
    }
    setSubmitting(true);
    try {
      await workflowsApi.createImport(parentWorkflowId, {
        childWorkflowId: selectedChildWorkflowId,
        mode,
      });
      toast.success(mode === 'copy' ? '已拷贝并导入子工作流' : '已引用导入子工作流');
      onImported();
      onOpenChange(false);
      setChildWorkflowId('');
      setMode('reference');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '导入失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="导入子工作流"
      footer={
        <>
          <button
            type="button"
            className="h-9 px-4 rounded-ctrl border border-line text-sm hover:bg-raised"
            onClick={() => onOpenChange(false)}
          >
            取消
          </button>
          <button
            type="button"
            disabled={submitting || loading || availableCandidates.length === 0}
            className="h-9 px-4 rounded-ctrl bg-brand text-white text-sm hover:bg-brand-hover disabled:opacity-50"
            onClick={() => void handleSubmit()}
          >
            {submitting ? '导入中…' : '确认导入'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-xs text-faint">导入后将出现在左侧「子工作流」列表，可添加到画布。</p>
        <Field label="目标工作流">
          <Select
            value={selectedChildWorkflowId}
            onValueChange={setChildWorkflowId}
            options={availableCandidates.map((c) => ({
              value: c.id,
              label: c.definition.name,
            }))}
            placeholder={
              loading
                ? '加载中…'
                : availableCandidates.length === 0
                  ? '没有可导入的工作流'
                  : '选择公开工作流'
            }
          />
        </Field>
        <Field label="模式">
          <Select
            value={mode}
            onValueChange={(v) => setMode(v as WorkflowImportMode)}
            options={[
              { value: 'reference', label: '引用（reference）— 实时解析最新定义' },
              { value: 'copy', label: '拷贝（copy）— 新建私有副本可编辑' },
            ]}
          />
        </Field>
      </div>
    </Modal>
  );
}
