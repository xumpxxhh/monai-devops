import { StepKinds, type StepKind } from '@monai-devops/core-engine';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCog } from '@fortawesome/free-solid-svg-icons';
import { Field, Input } from '../../shared/ui/form';
import { PluginConfigFormModal } from '../../shared/plugins';
import type { ConfigReferenceSource } from '../../shared/ui/json-schema-form/types';
import { SetStateStepPanel, WorkflowRefStepPanel } from './BuiltinStepPanels';

export interface StepInspectorSelection {
  id: string;
  data: {
    label: string;
    kind: StepKind;
    plugin?: string;
    stepId?: string;
    config?: Record<string, unknown>;
    patch?: Record<string, unknown>;
    workflowRef?: { importId: string };
    inputState?: unknown;
    loop?: {
      maxIterations: number;
      until?: { when: string; equals?: unknown; exists?: boolean };
    };
  };
}

export function StepInspectorPanel({
  selection,
  selectedStepId,
  selectedImport,
  configModalOpen,
  onConfigModalOpenChange,
  referenceSources,
  stateSchema,
  onUpdate,
}: {
  selection: StepInspectorSelection | null;
  selectedStepId?: string;
  selectedImport?: {
    id: string;
    label: string;
    mode: string;
    childStateSchema?: Record<string, unknown>;
  };
  configModalOpen: boolean;
  onConfigModalOpenChange: (open: boolean) => void;
  referenceSources: ConfigReferenceSource[];
  stateSchema: Record<string, unknown> | undefined;
  onUpdate: (patch: Partial<StepInspectorSelection['data']>) => void;
}) {
  return (
    <aside className="w-80 shrink-0 border-l border-line bg-surface p-4 overflow-auto">
      <h3 className="text-xs font-medium text-faint uppercase tracking-wider mb-3">步骤属性</h3>
      {selection ? (
        <>
          <Field label="步骤 ID">
            <Input mono readOnly value={selectedStepId ?? ''} placeholder="保存后生成" />
          </Field>
          <Field label="名称">
            <Input
              value={selection.data.label}
              onChange={(e) => onUpdate({ label: e.target.value })}
            />
          </Field>
          <Field label="类型">
            <Input mono readOnly value={selection.data.kind} />
          </Field>

          {selection.data.kind === StepKinds.PLUGIN && (
            <>
              <Field label="插件">
                <Input mono readOnly value={selection.data.plugin ?? ''} />
              </Field>
              <Field label="配置">
                <button
                  type="button"
                  onClick={() => onConfigModalOpenChange(true)}
                  className="inline-flex items-center gap-2 h-9 px-3 rounded-ctrl border border-line text-sm hover:bg-raised w-full justify-center"
                >
                  <FontAwesomeIcon icon={faCog} />
                  编辑配置
                </button>
                <p className="mt-2 text-xs text-faint font-mono truncate">
                  {JSON.stringify(selection.data.config ?? {})}
                </p>
              </Field>
              <PluginConfigFormModal
                open={configModalOpen}
                onOpenChange={onConfigModalOpenChange}
                pluginName={selection.data.plugin ?? ''}
                value={(selection.data.config ?? {}) as Record<string, unknown>}
                onConfirm={(config) => onUpdate({ config })}
                referenceSources={referenceSources}
              />
            </>
          )}

          {selection.data.kind === StepKinds.SET_STATE && (
            <SetStateStepPanel
              patch={selection.data.patch}
              onChange={(patch) => onUpdate({ patch })}
              referenceSources={referenceSources}
              stateSchema={stateSchema}
            />
          )}

          {selection.data.kind === StepKinds.WORKFLOW && (
            <WorkflowRefStepPanel
              importId={selection.data.workflowRef?.importId ?? ''}
              importLabel={selectedImport?.label ?? selection.data.workflowRef?.importId ?? ''}
              importMode={selectedImport?.mode ?? ''}
              inputState={selection.data.inputState}
              loop={selection.data.loop}
              childStateSchema={selectedImport?.childStateSchema}
              referenceSources={referenceSources}
              onChange={(patch) => onUpdate(patch)}
            />
          )}
        </>
      ) : (
        <p className="text-sm text-faint">点击画布中的节点编辑步骤属性</p>
      )}
    </aside>
  );
}
