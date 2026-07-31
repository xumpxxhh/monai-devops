import { useEffect, useRef, useState } from 'react';
import { Field, Input, Select, Textarea, Checkbox } from '../../shared/ui/form';
import { CodeEditor } from '../../shared/ui/code-editor';
import type { ConfigReferenceSource } from '../../shared/ui/json-schema-form/types';
import { isContextRef } from '@monai-devops/core-engine';

type PatchEntry = {
  key: string;
  mode: 'literal' | 'ref';
  literal: string;
  fromStepId: string;
  path: string;
};

function entriesFromPatch(patch: Record<string, unknown> | undefined): PatchEntry[] {
  const entries = Object.entries(patch ?? {});
  if (entries.length === 0) {
    return [{ key: '', mode: 'literal', literal: '', fromStepId: '', path: '' }];
  }
  return entries.map(([key, value]) => {
    if (isContextRef(value)) {
      return {
        key,
        mode: 'ref' as const,
        literal: '',
        fromStepId: value.$ref.fromStepId,
        path: value.$ref.path.join('.'),
      };
    }
    return {
      key,
      mode: 'literal' as const,
      literal: typeof value === 'string' ? value : JSON.stringify(value ?? ''),
      fromStepId: '',
      path: '',
    };
  });
}

function patchFromEntries(entries: PatchEntry[]): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const entry of entries) {
    const key = entry.key.trim();
    if (!key) continue;
    if (entry.mode === 'ref') {
      const path = entry.path
        .split('.')
        .map((p) => p.trim())
        .filter(Boolean);
      if (!entry.fromStepId.trim() || path.length === 0) continue;
      patch[key] = { $ref: { fromStepId: entry.fromStepId.trim(), path } };
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
}: {
  patch: Record<string, unknown> | undefined;
  onChange: (patch: Record<string, unknown>) => void;
  referenceSources: ConfigReferenceSource[];
}) {
  const [entries, setEntries] = useState(() => entriesFromPatch(patch));

  const commit = (next: PatchEntry[]) => {
    setEntries(next);
    onChange(patchFromEntries(next));
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-faint">浅合并到 run state；值可手填 JSON 或引用上游。</p>
      {entries.map((entry, index) => (
        <div key={index} className="rounded-ctrl border border-line p-2 space-y-2">
          <Field label="字段名">
            <Input
              value={entry.key}
              placeholder="count"
              onChange={(e) => {
                const next = [...entries];
                next[index] = { ...entry, key: e.target.value };
                commit(next);
              }}
            />
          </Field>
          <Field label="取值方式">
            <Select
              value={entry.mode}
              onValueChange={(mode) => {
                const next = [...entries];
                next[index] = { ...entry, mode: mode as 'literal' | 'ref' };
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
                  value={entry.fromStepId}
                  onValueChange={(fromStepId) => {
                    const next = [...entries];
                    next[index] = { ...entry, fromStepId };
                    commit(next);
                  }}
                  options={referenceSources.map((s) => ({
                    value: s.stepId,
                    label: `${s.label} (${s.plugin})`,
                  }))}
                  placeholder="选择上游"
                />
              </Field>
              <Field label="路径（点分）">
                <Input
                  value={entry.path}
                  placeholder="data.value"
                  onChange={(e) => {
                    const next = [...entries];
                    next[index] = { ...entry, path: e.target.value };
                    commit(next);
                  }}
                />
              </Field>
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
      ))}
      <button
        type="button"
        className="w-full h-8 rounded-ctrl border border-line text-xs hover:bg-raised"
        onClick={() =>
          commit([...entries, { key: '', mode: 'literal', literal: '', fromStepId: '', path: '' }])
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
  onChange,
}: {
  importId: string;
  importLabel: string;
  importMode: string;
  inputState?: unknown;
  loop?: { maxIterations: number; until?: { when: string; equals?: unknown; exists?: boolean } };
  onChange: (patch: {
    workflowRef?: { importId: string };
    inputState?: unknown;
    loop?: { maxIterations: number; until?: { when: string; equals?: unknown; exists?: boolean } };
  }) => void;
}) {
  const [inputJson, setInputJson] = useState(() =>
    inputState === undefined ? '' : JSON.stringify(inputState, null, 2),
  );
  const [inputError, setInputError] = useState('');
  const [untilEnabled, setUntilEnabled] = useState(Boolean(loop?.until));
  const [untilWhen, setUntilWhen] = useState(loop?.until?.when ?? '');
  const [untilEquals, setUntilEquals] = useState(
    loop?.until?.equals === undefined ? '' : JSON.stringify(loop.until.equals),
  );

  const modeLabel =
    importMode === 'copy' ? '拷贝' : importMode === 'reference' ? '引用' : importMode;
  const importSummary = importId
    ? `${importLabel || importId}${modeLabel ? ` · ${modeLabel}` : ''} · ${importId.slice(0, 8)}`
    : '未绑定导入记录';

  return (
    <div className="space-y-3">
      <Field label="已导入子工作流">
        <Input mono readOnly value={importSummary} />
      </Field>
      <Field label="inputState（JSON，可选）" error={inputError || undefined}>
        <Textarea
          rows={4}
          value={inputJson}
          placeholder="{}"
          onChange={(e) => {
            const raw = e.target.value;
            setInputJson(raw);
            if (!raw.trim()) {
              setInputError('');
              onChange({ inputState: undefined });
              return;
            }
            try {
              onChange({ inputState: JSON.parse(raw) as unknown });
              setInputError('');
            } catch {
              setInputError('JSON 无效');
            }
          }}
        />
      </Field>
      <Field label="循环 maxIterations">
        <Input
          type="number"
          min={1}
          value={loop?.maxIterations ?? ''}
          placeholder="不循环则留空"
          onChange={(e) => {
            const raw = e.target.value.trim();
            if (!raw) {
              onChange({ loop: undefined });
              return;
            }
            const maxIterations = Number(raw);
            if (!Number.isFinite(maxIterations) || maxIterations < 1) return;
            onChange({
              loop: {
                maxIterations,
                until: untilEnabled && untilWhen.trim() ? { when: untilWhen.trim() } : undefined,
              },
            });
          }}
        />
      </Field>
      <Checkbox
        id="loop-until"
        checked={untilEnabled}
        label="配置 until（需子工作流声明 stateSchema）"
        onCheckedChange={(checked) => {
          setUntilEnabled(checked);
          if (!loop?.maxIterations) return;
          if (!checked) {
            onChange({ loop: { maxIterations: loop.maxIterations } });
            return;
          }
          let equals: unknown;
          if (untilEquals.trim()) {
            try {
              equals = JSON.parse(untilEquals) as unknown;
            } catch {
              equals = untilEquals;
            }
          }
          onChange({
            loop: {
              maxIterations: loop.maxIterations,
              until: {
                when: untilWhen.trim() || 'state',
                ...(equals !== undefined ? { equals } : {}),
              },
            },
          });
        }}
      />
      {untilEnabled && (
        <>
          <Field label="until.when">
            <Input
              value={untilWhen}
              placeholder="如 done"
              onChange={(e) => {
                const when = e.target.value;
                setUntilWhen(when);
                if (!loop?.maxIterations) return;
                onChange({
                  loop: {
                    maxIterations: loop.maxIterations,
                    until: when.trim()
                      ? {
                          when: when.trim(),
                          ...(loop.until?.equals !== undefined
                            ? { equals: loop.until.equals }
                            : {}),
                          ...(loop.until?.exists !== undefined
                            ? { exists: loop.until.exists }
                            : {}),
                        }
                      : undefined,
                  },
                });
              }}
            />
          </Field>
          <Field label="until.equals（JSON，可选）">
            <Input
              value={untilEquals}
              placeholder="true"
              onChange={(e) => {
                const raw = e.target.value;
                setUntilEquals(raw);
                if (!loop?.maxIterations || !untilWhen.trim()) return;
                let equals: unknown;
                if (raw.trim()) {
                  try {
                    equals = JSON.parse(raw) as unknown;
                  } catch {
                    equals = raw;
                  }
                }
                onChange({
                  loop: {
                    maxIterations: loop.maxIterations,
                    until: {
                      when: untilWhen.trim(),
                      ...(equals !== undefined ? { equals } : {}),
                    },
                  },
                });
              }}
            />
          </Field>
        </>
      )}
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
