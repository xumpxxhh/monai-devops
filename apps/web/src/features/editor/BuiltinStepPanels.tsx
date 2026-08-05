import { useEffect, useMemo, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCog } from '@fortawesome/free-solid-svg-icons';
import { Field, Input, Select, Cascader, Checkbox } from '../../shared/ui/form';
import { CodeEditor } from '../../shared/ui/code-editor';
import { Modal } from '../../shared/ui/Modal';
import type {
  ConfigReferenceSource,
  JsonObjectSchema,
} from '../../shared/ui/json-schema-form/types';
import { JsonSchemaForm } from '../../shared/ui/json-schema-form';
import {
  coerceValidatedValues,
  validateAgainstSchema,
} from '../../shared/ui/json-schema-form/schema-utils';
import {
  buildResultFieldTree,
  cascaderValueToPath,
  formatContextRefLabel,
  isContextRef,
  pathToCascaderValue,
} from '../../shared/ui/json-schema-form/context-ref';

type WorkflowLoop = {
  maxIterations: number;
  until?: { when: string; equals?: unknown; exists?: boolean };
};

type PatchEntry = {
  key: string;
  mode: 'literal' | 'ref';
  literal: string;
  fromStepId: string;
  path: string[];
};

function stateSchemaFieldNames(schema: Record<string, unknown> | undefined): string[] {
  if (!schema || schema.type !== 'object') return [];
  const properties = schema.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return [];
  return Object.keys(properties as Record<string, unknown>);
}

function entriesFromPatch(patch: Record<string, unknown> | undefined): PatchEntry[] {
  const entries = Object.entries(patch ?? {});
  if (entries.length === 0) {
    return [{ key: '', mode: 'literal', literal: '', fromStepId: '', path: [] }];
  }
  return entries.map(([key, value]) => {
    if (isContextRef(value)) {
      return {
        key,
        mode: 'ref' as const,
        literal: '',
        fromStepId: value.$ref.fromStepId,
        path: [...value.$ref.path],
      };
    }
    return {
      key,
      mode: 'literal' as const,
      literal: typeof value === 'string' ? value : JSON.stringify(value ?? ''),
      fromStepId: '',
      path: [],
    };
  });
}

function patchFromEntries(entries: PatchEntry[]): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const entry of entries) {
    const key = entry.key.trim();
    if (!key) continue;
    if (entry.mode === 'ref') {
      if (!entry.fromStepId.trim()) continue;
      patch[key] = { $ref: { fromStepId: entry.fromStepId.trim(), path: entry.path } };
      continue;
    }
    const raw = entry.literal.trim();
    if (!raw) {
      patch[key] = '';
      continue;
    }
    try {
      patch[key] = JSON.parse(raw) as unknown;
    } catch {
      patch[key] = raw;
    }
  }
  return patch;
}

export function SetStateStepPanel({
  patch,
  onChange,
  referenceSources,
  stateSchema,
}: {
  patch: Record<string, unknown> | undefined;
  onChange: (patch: Record<string, unknown>) => void;
  referenceSources: ConfigReferenceSource[];
  stateSchema: Record<string, unknown> | undefined;
}) {
  const [entries, setEntries] = useState(() => entriesFromPatch(patch));
  const schemaKeys = useMemo(() => stateSchemaFieldNames(stateSchema), [stateSchema]);

  const commit = (next: PatchEntry[]) => {
    setEntries(next);
    onChange(patchFromEntries(next));
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-faint">浅合并到 run state；值可手填 JSON 或引用上游。</p>
      {schemaKeys.length === 0 && (
        <p className="text-xs text-failed">请先在工作流设置中声明 State Schema</p>
      )}
      {entries.map((entry, index) => {
        const usedKeys = new Set(
          entries.map((e, i) => (i !== index && e.key.trim() ? e.key.trim() : '')).filter(Boolean),
        );
        const keyOptions = [
          ...schemaKeys.map((name) => ({
            value: name,
            label: name,
            disabled: usedKeys.has(name),
          })),
          ...(entry.key && !schemaKeys.includes(entry.key)
            ? [{ value: entry.key, label: `${entry.key}（不在 Schema 中）`, disabled: false }]
            : []),
        ];
        const selectedSource =
          referenceSources.find((s) => s.stepId === entry.fromStepId) ??
          referenceSources[0] ??
          null;
        const pathTree = selectedSource ? buildResultFieldTree(selectedSource.resultSchema) : [];

        return (
          <div key={index} className="rounded-ctrl border border-line p-2 space-y-2">
            <Field label="字段名">
              <Select
                value={entry.key}
                onValueChange={(key) => {
                  const next = [...entries];
                  next[index] = { ...entry, key };
                  commit(next);
                }}
                options={keyOptions}
                placeholder="选择 State 字段"
                emptyText="暂无 State Schema 字段"
                disabled={schemaKeys.length === 0 && !entry.key}
              />
            </Field>
            <Field label="取值方式">
              <Select
                value={entry.mode}
                onValueChange={(mode) => {
                  const next = [...entries];
                  const nextMode = mode as 'literal' | 'ref';
                  if (nextMode === 'ref') {
                    const first = referenceSources[0];
                    next[index] = {
                      ...entry,
                      mode: nextMode,
                      fromStepId: first?.stepId ?? '',
                      path: [],
                    };
                  } else {
                    next[index] = { ...entry, mode: nextMode };
                  }
                  commit(next);
                }}
                options={[
                  { value: 'literal', label: '手填' },
                  { value: 'ref', label: '引用上游' },
                ]}
              />
            </Field>
            {entry.mode === 'literal' ? (
              <Field label="值（JSON 或字符串）">
                <Input
                  value={entry.literal}
                  placeholder='"hello" 或 1'
                  onChange={(e) => {
                    const next = [...entries];
                    next[index] = { ...entry, literal: e.target.value };
                    commit(next);
                  }}
                />
              </Field>
            ) : (
              <>
                <Field label="上游步骤">
                  <Select
                    value={selectedSource?.stepId ?? ''}
                    onValueChange={(fromStepId) => {
                      const next = [...entries];
                      next[index] = { ...entry, fromStepId, path: [] };
                      commit(next);
                    }}
                    options={referenceSources.map((s) => ({
                      value: s.stepId,
                      label: `${s.label}（${s.plugin}）`,
                    }))}
                    placeholder="选择上游"
                    disabled={referenceSources.length === 0}
                  />
                </Field>
                <Field label="路径">
                  <Cascader
                    value={pathToCascaderValue(entry.path)}
                    onValueChange={(nextValue) => {
                      const path = cascaderValueToPath(nextValue);
                      const stepId = selectedSource?.stepId ?? entry.fromStepId;
                      if (!stepId) return;
                      const next = [...entries];
                      next[index] = { ...entry, fromStepId: stepId, path };
                      commit(next);
                    }}
                    options={pathTree}
                    disabled={!selectedSource}
                    placeholder="选择结果路径"
                  />
                </Field>
                {entry.fromStepId && (
                  <p className="text-xs text-muted">
                    {formatContextRefLabel(
                      { $ref: { fromStepId: entry.fromStepId, path: entry.path } },
                      selectedSource?.label,
                    )}
                  </p>
                )}
                {referenceSources.length === 0 && (
                  <p className="text-xs text-faint">
                    暂无可引用源（需声明 State Schema，或依赖声明了 resultSchema 的祖先步骤）
                  </p>
                )}
              </>
            )}
            <button
              type="button"
              className="text-xs text-failed hover:underline"
              onClick={() => commit(entries.filter((_, i) => i !== index))}
            >
              删除字段
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="w-full h-8 rounded-ctrl border border-line text-xs hover:bg-raised"
        onClick={() =>
          commit([...entries, { key: '', mode: 'literal', literal: '', fromStepId: '', path: [] }])
        }
      >
        添加字段
      </button>
    </div>
  );
}

export function WorkflowRefStepPanel({
  importId,
  importLabel,
  importMode,
  inputState,
  loop,
  childStateSchema,
  referenceSources,
  onChange,
}: {
  importId: string;
  importLabel: string;
  importMode: string;
  inputState?: unknown;
  loop?: WorkflowLoop;
  childStateSchema?: Record<string, unknown>;
  referenceSources: ConfigReferenceSource[];
  onChange: (patch: {
    workflowRef?: { importId: string };
    inputState?: unknown;
    loop?: WorkflowLoop;
  }) => void;
}) {
  const [inputStateModalOpen, setInputStateModalOpen] = useState(false);
  const [loopModalOpen, setLoopModalOpen] = useState(false);
  const [draftInputState, setDraftInputState] = useState<Record<string, unknown>>({});
  const [inputStateErrors, setInputStateErrors] = useState<Record<string, string>>({});
  const [draftMaxIterations, setDraftMaxIterations] = useState('');
  const [draftUntilEnabled, setDraftUntilEnabled] = useState(false);
  const [draftUntilWhen, setDraftUntilWhen] = useState('');
  const [draftUntilEquals, setDraftUntilEquals] = useState('');
  const [untilEqualsError, setUntilEqualsError] = useState('');

  const modeLabel =
    importMode === 'copy' ? '拷贝' : importMode === 'reference' ? '引用' : importMode;
  const importSummary = importId
    ? `${importLabel || importId}${modeLabel ? ` · ${modeLabel}` : ''} · ${importId.slice(0, 8)}`
    : '未绑定导入记录';

  const inputStateValue =
    inputState !== undefined &&
    typeof inputState === 'object' &&
    inputState !== null &&
    !Array.isArray(inputState)
      ? (inputState as Record<string, unknown>)
      : {};

  const formSchema =
    childStateSchema && typeof childStateSchema === 'object' && childStateSchema.type === 'object'
      ? (childStateSchema as JsonObjectSchema)
      : undefined;

  const loopSummary = loop
    ? `maxIterations=${loop.maxIterations}${
        loop.until?.when ? ` · until.when=${loop.until.when}` : ''
      }`
    : '未配置循环';

  const openInputStateModal = () => {
    setDraftInputState({ ...inputStateValue });
    setInputStateErrors({});
    setInputStateModalOpen(true);
  };

  const openLoopModal = () => {
    setDraftMaxIterations(loop?.maxIterations != null ? String(loop.maxIterations) : '');
    setDraftUntilEnabled(Boolean(loop?.until));
    setDraftUntilWhen(loop?.until?.when ?? '');
    setDraftUntilEquals(loop?.until?.equals === undefined ? '' : JSON.stringify(loop.until.equals));
    setUntilEqualsError('');
    setLoopModalOpen(true);
  };

  const confirmInputState = () => {
    if (!formSchema) return;
    const errors = validateAgainstSchema(formSchema, draftInputState, { referenceSources });
    setInputStateErrors(errors);
    if (Object.keys(errors).length > 0) return;
    const coerced = coerceValidatedValues(formSchema, draftInputState);
    const keys = Object.keys(coerced);
    onChange({ inputState: keys.length === 0 ? undefined : coerced });
    setInputStateModalOpen(false);
  };

  const confirmLoop = () => {
    const raw = draftMaxIterations.trim();
    if (!raw) {
      onChange({ loop: undefined });
      setLoopModalOpen(false);
      return;
    }
    const maxIterations = Number(raw);
    if (!Number.isFinite(maxIterations) || maxIterations < 1) return;

    if (!draftUntilEnabled || !formSchema) {
      onChange({ loop: { maxIterations } });
      setLoopModalOpen(false);
      return;
    }

    const when = draftUntilWhen.trim();
    if (!when) {
      onChange({ loop: { maxIterations } });
      setLoopModalOpen(false);
      return;
    }

    let equals: unknown;
    if (draftUntilEquals.trim()) {
      try {
        equals = JSON.parse(draftUntilEquals) as unknown;
        setUntilEqualsError('');
      } catch {
        setUntilEqualsError('JSON 无效');
        return;
      }
    }

    onChange({
      loop: {
        maxIterations,
        until: {
          when,
          ...(equals !== undefined ? { equals } : {}),
        },
      },
    });
    setLoopModalOpen(false);
  };

  return (
    <div className="space-y-3">
      <Field label="已导入子工作流">
        <Input mono readOnly value={importSummary} />
      </Field>

      <Field label="inputState">
        {formSchema ? (
          <>
            <button
              type="button"
              onClick={openInputStateModal}
              className="inline-flex items-center gap-2 h-9 px-3 rounded-ctrl border border-line text-sm hover:bg-raised w-full justify-center"
            >
              <FontAwesomeIcon icon={faCog} />
              编辑 inputState
            </button>
            <p className="mt-2 text-xs text-faint font-mono truncate">
              {JSON.stringify(inputState ?? {})}
            </p>
          </>
        ) : (
          <p className="text-xs text-faint">
            子工作流未声明 stateSchema，无需 / 不可配置 inputState
          </p>
        )}
      </Field>

      <Field label="循环">
        <button
          type="button"
          onClick={openLoopModal}
          className="inline-flex items-center gap-2 h-9 px-3 rounded-ctrl border border-line text-sm hover:bg-raised w-full justify-center"
        >
          <FontAwesomeIcon icon={faCog} />
          配置循环 / until
        </button>
        <p className="mt-2 text-xs text-faint font-mono truncate">{loopSummary}</p>
      </Field>

      {formSchema && (
        <Modal
          open={inputStateModalOpen}
          onOpenChange={setInputStateModalOpen}
          title="配置 inputState"
          contentClassName="max-w-lg"
          footer={
            <>
              <button
                type="button"
                onClick={() => setInputStateModalOpen(false)}
                className="h-9 px-4 rounded-ctrl border border-line text-sm hover:bg-raised"
              >
                取消
              </button>
              <button
                type="button"
                onClick={confirmInputState}
                className="h-9 px-4 rounded-ctrl bg-brand text-white text-sm font-medium hover:bg-brand-hover"
              >
                确定
              </button>
            </>
          }
        >
          <p className="mb-3 text-xs text-faint">
            按子工作流 State Schema 填写；字段可手填或引用上游。
          </p>
          <JsonSchemaForm
            schema={formSchema}
            value={draftInputState}
            errors={inputStateErrors}
            onChange={(next) => {
              setDraftInputState(next);
              setInputStateErrors({});
            }}
            referenceSources={referenceSources}
          />
        </Modal>
      )}

      <Modal
        open={loopModalOpen}
        onOpenChange={setLoopModalOpen}
        title="配置循环 / until"
        contentClassName="max-w-lg"
        footer={
          <>
            <button
              type="button"
              onClick={() => setLoopModalOpen(false)}
              className="h-9 px-4 rounded-ctrl border border-line text-sm hover:bg-raised"
            >
              取消
            </button>
            <button
              type="button"
              onClick={confirmLoop}
              className="h-9 px-4 rounded-ctrl bg-brand text-white text-sm font-medium hover:bg-brand-hover"
            >
              确定
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="maxIterations">
            <Input
              type="number"
              min={1}
              value={draftMaxIterations}
              placeholder="不循环则留空"
              onChange={(e) => setDraftMaxIterations(e.target.value)}
            />
          </Field>
          <Checkbox
            id="loop-until-modal"
            checked={draftUntilEnabled}
            disabled={!formSchema}
            label={
              formSchema
                ? '配置 until（基于子工作流 state）'
                : '配置 until（需子工作流声明 stateSchema）'
            }
            onCheckedChange={setDraftUntilEnabled}
          />
          {draftUntilEnabled && formSchema && (
            <>
              <Field label="until.when">
                <Input
                  value={draftUntilWhen}
                  placeholder="如 done"
                  onChange={(e) => setDraftUntilWhen(e.target.value)}
                />
              </Field>
              <Field label="until.equals（JSON，可选）" error={untilEqualsError || undefined}>
                <Input
                  value={draftUntilEquals}
                  placeholder="true"
                  onChange={(e) => {
                    setDraftUntilEquals(e.target.value);
                    setUntilEqualsError('');
                  }}
                />
              </Field>
            </>
          )}
        </div>
      </Modal>
    </div>
  );
}

type StateSchemaField = {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required: boolean;
};

function schemaToFields(schema: Record<string, unknown> | undefined): StateSchemaField[] {
  if (!schema || schema.type !== 'object') return [];
  const properties = (schema.properties ?? {}) as Record<string, { type?: string }>;
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((x): x is string => typeof x === 'string')
      : [],
  );
  return Object.entries(properties).map(([name, def]) => ({
    name,
    type: (['string', 'number', 'boolean', 'object', 'array'].includes(def.type ?? '')
      ? def.type
      : 'string') as StateSchemaField['type'],
    required: required.has(name),
  }));
}

function fieldsToSchema(fields: StateSchemaField[]): Record<string, unknown> | undefined {
  const valid = fields.filter((f) => f.name.trim());
  if (valid.length === 0) return undefined;
  const properties: Record<string, { type: string }> = {};
  const required: string[] = [];
  for (const field of valid) {
    const name = field.name.trim();
    properties[name] = { type: field.type };
    if (field.required) required.push(name);
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

export function StateSchemaEditor({
  value,
  onChange,
}: {
  value: Record<string, unknown> | undefined;
  onChange: (schema: Record<string, unknown> | undefined) => void;
}) {
  const [fields, setFields] = useState(() => schemaToFields(value));
  const [jsonText, setJsonText] = useState(() => (value ? JSON.stringify(value, null, 2) : ''));
  const [jsonError, setJsonError] = useState('');
  const fieldsListRef = useRef<HTMLDivElement>(null);
  const scrollToBottomOnAddRef = useRef(false);

  const applyFields = (next: StateSchemaField[]) => {
    setFields(next);
    const schema = fieldsToSchema(next);
    onChange(schema);
    setJsonText(schema ? JSON.stringify(schema, null, 2) : '');
    setJsonError('');
  };

  useEffect(() => {
    if (!scrollToBottomOnAddRef.current) return;
    scrollToBottomOnAddRef.current = false;
    const el = fieldsListRef.current;
    if (!el || el.scrollHeight <= el.clientHeight) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [fields]);

  const schema = fieldsToSchema(fields);
  const hasValidFields = schema !== undefined;

  return (
    <div className={hasValidFields ? 'grid grid-cols-1 gap-3 md:grid-cols-2' : 'space-y-2'}>
      <div className="flex flex-col min-h-0 max-h-[60vh] space-y-2 py-2">
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs font-medium text-muted">字段</p>
          <p className="text-xs text-faint mt-0.5 text-right">
            不添加字段 = 本工作流无 stateSchema。
          </p>
        </div>

        <div ref={fieldsListRef} className="flex flex-col gap-2 flex-1 overflow-y-auto py-2">
          {fields.map((field, index) => (
            <div key={index} className="rounded-ctrl border border-line p-2 space-y-2">
              <Field label="字段名" className="mb-0">
                <Input
                  value={field.name}
                  onChange={(e) => {
                    const next = [...fields];
                    next[index] = { ...field, name: e.target.value };
                    applyFields(next);
                  }}
                />
              </Field>
              <Field label="类型" className="mb-0">
                <Select
                  value={field.type}
                  onValueChange={(type) => {
                    const next = [...fields];
                    next[index] = { ...field, type: type as StateSchemaField['type'] };
                    applyFields(next);
                  }}
                  options={[
                    { value: 'string', label: 'string' },
                    { value: 'number', label: 'number' },
                    { value: 'boolean', label: 'boolean' },
                    { value: 'object', label: 'object' },
                    { value: 'array', label: 'array' },
                  ]}
                />
              </Field>
              <div className="flex h-5 items-center justify-between">
                <Checkbox
                  id={`state-req-${index}`}
                  checked={field.required}
                  label="必填"
                  className="leading-none"
                  onCheckedChange={(required) => {
                    const next = [...fields];
                    next[index] = { ...field, required };
                    applyFields(next);
                  }}
                />
                <button
                  type="button"
                  className="h-5 px-2 text-xs leading-none text-failed hover:opacity-80"
                  onClick={() => applyFields(fields.filter((_, i) => i !== index))}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="w-full h-8 rounded-ctrl border border-line text-xs hover:bg-raised"
          onClick={() => {
            scrollToBottomOnAddRef.current = true;
            applyFields([...fields, { name: '', type: 'string', required: false }]);
          }}
        >
          添加字段
        </button>
      </div>

      {hasValidFields && (
        <div className="min-h-0 max-h-[60vh] py-2 [overflow-anchor:none]">
          <Field
            label="JSON Schema"
            className="mb-0 h-full flex flex-col"
            error={jsonError || undefined}
          >
            <CodeEditor
              language="json"
              value={jsonText}
              lint={Boolean(jsonText.trim())}
              minHeight="12rem"
              className="min-h-[12rem] flex-1"
              placeholder='{ "type": "object", "properties": {} }'
              onChange={(raw) => {
                setJsonText(raw);
                if (!raw.trim()) {
                  setJsonError('');
                  onChange(undefined);
                  setFields([]);
                  return;
                }
                try {
                  const parsed = JSON.parse(raw) as Record<string, unknown>;
                  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                    setJsonError('须为 JSON 对象');
                    return;
                  }
                  setJsonError('');
                  onChange(parsed);
                  setFields(schemaToFields(parsed));
                } catch {
                  setJsonError('JSON 无效');
                }
              }}
            />
          </Field>
        </div>
      )}
    </div>
  );
}
