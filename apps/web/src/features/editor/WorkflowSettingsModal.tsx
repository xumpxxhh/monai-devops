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
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="工作流设置" contentClassName="max-w-lg">
      <div className="space-y-4">
        <Field label="工作流 ID" htmlFor="settings-workflow-id">
          <Input
            id="settings-workflow-id"
            mono
            readOnly
            value={workflowId ?? ''}
            placeholder="保存后生成"
          />
        </Field>
        <Field label="名称" htmlFor="settings-workflow-name" error={workflowNameError || undefined}>
          <Input
            id="settings-workflow-name"
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
