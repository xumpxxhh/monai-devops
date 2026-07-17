import { Modal } from '../Modal';
import { JsonSchemaForm } from './JsonSchemaForm';
import { usePluginConfigSchema } from './usePluginConfigSchema';
import type { ConfigReferenceSource } from './types';

interface PluginConfigFormModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pluginName: string;
  value: Record<string, unknown>;
  onConfirm: (config: Record<string, unknown>) => void;
  referenceSources?: ConfigReferenceSource[];
}

export function PluginConfigFormModal({
  open,
  onOpenChange,
  pluginName,
  value,
  onConfirm,
  referenceSources,
}: PluginConfigFormModalProps) {
  const { schema, loading, loadError, formValue, setFormValue, fieldErrors, validate, ready } =
    usePluginConfigSchema(pluginName, { enabled: open, initialValue: value });

  const handleConfirm = () => {
    const result = validate();
    if (!result.ok) return;
    onConfirm(result.config);
    onOpenChange(false);
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`配置 · ${pluginName}`}
      contentClassName="max-w-lg"
      footer={
        <>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="h-9 px-4 rounded-ctrl border border-line text-sm hover:bg-raised"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={loading || !ready}
            className="h-9 px-4 rounded-ctrl bg-brand text-white text-sm font-medium hover:bg-brand-hover disabled:opacity-50"
          >
            确定
          </button>
        </>
      }
    >
      {loading && <p className="text-sm text-faint">加载配置表单…</p>}
      {loadError && <p className="text-sm text-failed">{loadError}</p>}
      {!loading && !loadError && schema && (
        <JsonSchemaForm
          schema={schema}
          value={formValue}
          errors={fieldErrors}
          onChange={setFormValue}
          referenceSources={referenceSources}
        />
      )}
    </Modal>
  );
}
