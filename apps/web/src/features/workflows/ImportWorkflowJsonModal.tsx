import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import type { WorkflowDefinition } from '@monai-devops/core-engine';
import { pluginsApi } from '../../shared/api/misc';
import { workflowsApi } from '../../shared/api/workflows';
import { Field, Input } from '../../shared/ui/form';
import { Modal } from '../../shared/ui/Modal';
import { validateWorkflowName } from '../editor/workflow-name';
import { buildImportPreview, definitionToDraft, suggestImportName } from './workflow-import-utils';

export function ImportWorkflowJsonModal({
  open,
  onOpenChange,
  definition,
  existingNames,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  definition: WorkflowDefinition | null;
  existingNames: ReadonlySet<string>;
}) {
  const navigate = useNavigate();
  const sessionKey = open && definition ? `${definition.id}:${definition.name}` : null;

  const [prevSessionKey, setPrevSessionKey] = useState(sessionKey);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [registeredPlugins, setRegisteredPlugins] = useState<ReadonlySet<string>>(() => new Set());
  const [pluginsLoading, setPluginsLoading] = useState(false);

  if (sessionKey !== prevSessionKey) {
    setPrevSessionKey(sessionKey);
    if (sessionKey !== null && definition) {
      setName(suggestImportName(definition.name, existingNames));
      setNameError(undefined);
      setSubmitting(false);
      setPluginsLoading(true);
    }
  }

  const preview = useMemo(() => {
    if (!definition) return null;
    return buildImportPreview(definition, registeredPlugins, existingNames);
  }, [definition, registeredPlugins, existingNames]);

  useEffect(() => {
    if (sessionKey === null) return;
    let cancelled = false;
    void pluginsApi
      .list()
      .then((plugins) => {
        if (cancelled) return;
        setRegisteredPlugins(new Set(plugins.map((p) => p.name)));
      })
      .catch((e) => {
        if (!cancelled) {
          toast.error(e instanceof Error ? e.message : '加载插件列表失败');
        }
      })
      .finally(() => {
        if (!cancelled) setPluginsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionKey]);

  const handleSubmit = async () => {
    if (!definition || !preview) return;

    const trimmedName = name.trim();
    const validationError = validateWorkflowName(trimmedName);
    if (validationError) {
      setNameError(validationError);
      return;
    }
    setNameError(undefined);

    if (preview.missingPlugins.length > 0) {
      toast.error('存在未注册的插件，无法导入');
      return;
    }

    const { draft } = definitionToDraft(definition);
    if (draft.steps.length === 0) {
      toast.error('没有可导入的步骤（子工作流引用步骤已被跳过）');
      return;
    }

    draft.name = trimmedName;
    setSubmitting(true);
    try {
      await workflowsApi.validate(draft);
      const record = await workflowsApi.create(draft);
      onOpenChange(false);
      toast.success(
        preview.skippedWorkflowStepCount > 0
          ? '工作流已导入（子工作流引用步骤已跳过，请重新导入）'
          : '工作流已导入',
      );
      navigate(`/workflows/${record.id}/edit`);
    } catch (e) {
      const message = e instanceof Error ? e.message : '导入工作流失败';
      if (message.includes('已存在')) {
        setNameError('工作流名称已存在，请修改后重试');
      } else {
        toast.error(message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit =
    !!preview &&
    !pluginsLoading &&
    preview.stepCount > 0 &&
    preview.missingPlugins.length === 0 &&
    !submitting;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="导入工作流 JSON"
      contentClassName="max-w-lg"
      footer={
        <>
          <button
            type="button"
            className="px-4 py-2 text-sm rounded-ctrl border border-line"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            取消
          </button>
          <button
            type="button"
            className="px-4 py-2 text-sm rounded-ctrl bg-brand text-white disabled:opacity-50"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
          >
            {submitting ? '导入中…' : '导入'}
          </button>
        </>
      }
    >
      {!definition ? (
        <p className="text-faint">未选择文件</p>
      ) : pluginsLoading ? (
        <p className="text-faint">加载插件列表…</p>
      ) : preview ? (
        <div className="space-y-4">
          <Field label="工作流名称" error={nameError}>
            <Input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (nameError) setNameError(undefined);
              }}
              aria-invalid={nameError ? true : undefined}
            />
          </Field>

          <p className="text-sm">
            将导入 <span className="font-medium text-ink">{preview.stepCount}</span> 个步骤
            {preview.skippedWorkflowStepCount > 0 ? (
              <>
                ，已跳过{' '}
                <span className="font-medium text-ink">{preview.skippedWorkflowStepCount}</span>{' '}
                个子工作流引用步骤
              </>
            ) : null}
            。
          </p>

          {preview.missingPlugins.length > 0 ? (
            <div className="rounded-ctrl border border-failed/30 bg-failed/5 px-3 py-2 text-sm text-failed">
              <p className="font-medium">以下插件未注册，无法导入：</p>
              <ul className="mt-1 list-disc pl-5">
                {preview.missingPlugins.map((plugin) => (
                  <li key={plugin}>{plugin}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {preview.skippedWorkflowStepCount > 0 && preview.missingPlugins.length === 0 ? (
            <p className="text-xs text-faint">
              跳过的子工作流引用步骤不会写入新工作流，可在编辑器中重新导入子工作流。
            </p>
          ) : null}

          {preview.stepCount === 0 ? (
            <p className="text-sm text-failed">没有可导入的步骤。</p>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
