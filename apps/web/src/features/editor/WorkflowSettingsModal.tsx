import { Field, Input } from '../../shared/ui/form';
import { Modal } from '../../shared/ui/Modal';
import { StateSchemaEditor } from './BuiltinStepPanels';
import { validateWorkflowName } from './workflow-name';

export function WorkflowSettingsModal({
  open,
  onOpenChange,
  workflowId,
  workflowName,
  onWorkflowNameChange,
  workflowNameError,
  onWorkflowNameErrorChange,
  stateSchema,
  onStateSchemaChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workflowId: string | null;
  workflowName: string;
  onWorkflowNameChange: (name: string) => void;
  workflowNameError?: string;
  onWorkflowNameErrorChange: (error: string) => void;
  stateSchema: Record<string, unknown> | undefined;
  onStateSchemaChange: (schema: Record<string, unknown> | undefined) => void;
}) {
  const schemaAny = stateSchema as { type?: unknown; properties?: unknown } | undefined;
  const properties = schemaAny?.properties;
  const hasValidFields =
    schemaAny?.type === 'object' &&
    !!properties &&
    typeof properties === 'object' &&
    !Array.isArray(properties) &&
    Object.keys(properties as Record<string, unknown>).some((key) => key.trim().length > 0);

  const contentClassName = `${hasValidFields ? 'max-w-4xl' : 'max-w-lg'} transition-[max-width] duration-200 ease-in-out`;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="工作流设置"
      contentClassName={contentClassName}
    >
      <div className="space-y-4">
        <Field label="工作流 ID">
          <Input mono readOnly value={workflowId ?? ''} placeholder="保存后生成" />
        </Field>
        <Field label="名称" error={workflowNameError || undefined}>
          <Input
            value={workflowName}
            placeholder="请输入工作流名称"
            onChange={(e) => {
              onWorkflowNameChange(e.target.value);
              if (workflowNameError) {
                onWorkflowNameErrorChange(validateWorkflowName(e.target.value) ?? '');
              }
            }}
          />
        </Field>
        <div>
          <h3 className="text-xs font-medium text-faint uppercase tracking-wider mb-3">
            State Schema
          </h3>
          <StateSchemaEditor value={stateSchema} onChange={onStateSchemaChange} />
        </div>
      </div>
    </Modal>
  );
}
