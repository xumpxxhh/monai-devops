import { useEffect, useState } from 'react';
import { Field, Input, Select, Cascader, Switch } from '../form';
import { CodeEditor } from '../code-editor';
import type { ConfigReferenceSource, JsonObjectSchema, JsonSchemaProperty } from './types';
import {
  humanizeFieldLabel,
  isSensitiveField,
  literalFallbackForProp,
  validateContextRefType,
} from './schema-utils';
import {
  RESULT_ROOT_VALUE,
  buildResultFieldTree,
  cascaderValueToPath,
  formatContextRefLabel,
  isContextRef,
  pathToCascaderValue,
  schemaBasicTypeLabel,
} from './context-ref';

interface JsonSchemaFormProps {
  schema: JsonObjectSchema;
  value: Record<string, unknown>;
  errors?: Record<string, string>;
  onChange: (value: Record<string, unknown>) => void;
  disabled?: boolean;
  /** 可引用的上游步骤（有 resultSchema）；为空时不显示引用切换 */
  referenceSources?: ConfigReferenceSource[];
}

function JsonStructuredLiteralField({
  fieldId,
  label,
  error,
  showLabel,
  expectArray,
  fieldValue,
  onCommit,
  disabled,
}: {
  fieldId: string;
  label: string;
  error?: string;
  showLabel: boolean;
  expectArray: boolean;
  fieldValue: unknown;
  onCommit: (parsed: unknown) => void;
  disabled?: boolean;
}) {
  const serialize = (v: unknown) => {
    const fallback = expectArray ? [] : {};
    try {
      return JSON.stringify(v ?? fallback, null, 2);
    } catch {
      return JSON.stringify(fallback, null, 2);
    }
  };

  const [text, setText] = useState(() => serialize(fieldValue));
  const [localError, setLocalError] = useState('');

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- 外部 value 变化时重置编辑草稿（切换手填/引用） */
    setText(serialize(fieldValue));
    setLocalError('');
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 刻意不依赖 serialize
  }, [fieldValue]);

  return (
    <Field
      id={fieldId}
      label={showLabel ? label : undefined}
      error={error || localError || undefined}
    >
      <CodeEditor
        language="json"
        value={text}
        lint={Boolean(text.trim())}
        minHeight="6rem"
        disabled={disabled}
        placeholder={expectArray ? '[]' : '{}'}
        onChange={(raw) => {
          setText(raw);
          if (!raw.trim()) {
            setLocalError(expectArray ? '须为 JSON 数组' : '须为 JSON 对象');
            return;
          }
          try {
            const parsed = JSON.parse(raw) as unknown;
            if (expectArray && !Array.isArray(parsed)) {
              setLocalError('须为 JSON 数组');
              return;
            }
            if (
              !expectArray &&
              (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
            ) {
              setLocalError('须为 JSON 对象');
              return;
            }
            setLocalError('');
            onCommit(parsed);
          } catch {
            setLocalError('JSON 无效');
          }
        }}
      />
    </Field>
  );
}

function renderLiteralField(
  key: string,
  prop: JsonSchemaProperty,
  value: Record<string, unknown>,
  errors: Record<string, string>,
  onChange: (value: Record<string, unknown>) => void,
  disabled?: boolean,
  options?: { hideOuterLabel?: boolean },
) {
  const fieldId = `schema-field-${key}`;
  const label = humanizeFieldLabel(key, prop.description);
  const error = errors[key];
  const fieldValue = value[key];
  const showLabel = !options?.hideOuterLabel;

  if (prop.enum?.length) {
    const selectOptions = prop.enum.map((item) => ({
      value: String(item),
      label: String(item),
    }));
    return (
      <Field key={key} id={fieldId} label={showLabel ? label : undefined} error={error}>
        <Select
          value={fieldValue !== undefined ? String(fieldValue) : ''}
          onValueChange={(next) => {
            const matched = prop.enum!.find((item) => String(item) === next);
            onChange({ ...value, [key]: matched ?? next });
          }}
          options={selectOptions}
          disabled={disabled}
        />
      </Field>
    );
  }

  if (prop.type === 'boolean') {
    return (
      <Field key={key} id={fieldId} error={error} className="mb-3">
        <Switch
          checked={Boolean(fieldValue)}
          onCheckedChange={(checked) => onChange({ ...value, [key]: checked })}
          disabled={disabled}
          label={showLabel ? label : undefined}
        />
      </Field>
    );
  }

  if (prop.type === 'number' || prop.type === 'integer') {
    return (
      <Field key={key} id={fieldId} label={showLabel ? label : undefined} error={error}>
        <Input
          type="number"
          value={fieldValue !== undefined && fieldValue !== null ? String(fieldValue) : ''}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === '') {
              onChange({ ...value, [key]: '' });
              return;
            }
            // 保留输入中间态（如 "-" / "1."）；完整可解析数字写入 number
            if (/^-?\d*\.$/.test(raw) || raw === '-' || raw === '+') {
              onChange({ ...value, [key]: raw });
              return;
            }
            const n = Number(raw);
            onChange({ ...value, [key]: Number.isFinite(n) ? n : raw });
          }}
          disabled={disabled}
        />
      </Field>
    );
  }

  if (prop.type === 'object' || prop.type === 'array') {
    return (
      <JsonStructuredLiteralField
        key={key}
        fieldId={fieldId}
        label={label}
        error={error}
        showLabel={showLabel}
        expectArray={prop.type === 'array'}
        fieldValue={fieldValue}
        disabled={disabled}
        onCommit={(parsed) => onChange({ ...value, [key]: parsed })}
      />
    );
  }

  return (
    <Field key={key} id={fieldId} label={showLabel ? label : undefined} error={error}>
      <Input
        type={isSensitiveField(key) ? 'password' : 'text'}
        value={fieldValue !== undefined ? String(fieldValue) : ''}
        onChange={(e) => onChange({ ...value, [key]: e.target.value })}
        disabled={disabled}
        autoComplete={isSensitiveField(key) ? 'off' : undefined}
      />
    </Field>
  );
}

function FieldModeToggle({
  isRef,
  onToggle,
  disabled,
}: {
  isRef: boolean;
  onToggle: (next: 'literal' | 'ref') => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex gap-1 text-xs">
      <button
        type="button"
        disabled={disabled}
        onClick={() => onToggle('literal')}
        className={`h-6 px-2 rounded-ctrl border ${
          !isRef ? 'border-brand text-brand bg-brand/5' : 'border-line text-muted hover:bg-raised'
        } disabled:opacity-50`}
      >
        手填
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onToggle('ref')}
        className={`h-6 px-2 rounded-ctrl border ${
          isRef ? 'border-brand text-brand bg-brand/5' : 'border-line text-muted hover:bg-raised'
        } disabled:opacity-50`}
      >
        引用上游
      </button>
    </div>
  );
}

function ReferenceFieldEditor({
  fieldKey,
  expectedProp,
  value,
  sources,
  error,
  onChange,
  disabled,
}: {
  fieldKey: string;
  expectedProp: JsonSchemaProperty;
  value: Record<string, unknown>;
  sources: ConfigReferenceSource[];
  error?: string;
  onChange: (value: Record<string, unknown>) => void;
  disabled?: boolean;
}) {
  const fieldValue = value[fieldKey];
  const ref = isContextRef(fieldValue) ? fieldValue : null;
  const selectedSource =
    sources.find((s) => s.stepId === ref?.$ref.fromStepId) ?? sources[0] ?? null;
  const pathTree = selectedSource
    ? buildResultFieldTree(selectedSource.resultSchema)
    : [{ value: RESULT_ROOT_VALUE, label: '整个结果' }];

  const typeError =
    ref && sources.length > 0 ? validateContextRefType(expectedProp, ref, sources) : undefined;
  const displayError = error || typeError;

  return (
    <div className="space-y-2">
      <Select
        id={`ref-step-${fieldKey}`}
        value={selectedSource?.stepId ?? ''}
        onValueChange={(stepId) => {
          const source = sources.find((s) => s.stepId === stepId);
          if (!source) return;
          onChange({
            ...value,
            [fieldKey]: { $ref: { fromStepId: source.stepId, path: [] } },
          });
        }}
        options={sources.map((s) => ({
          value: s.stepId,
          label: `${s.label}（${s.plugin}）`,
        }))}
        disabled={disabled || sources.length === 0}
      />
      <Cascader
        id={`ref-path-${fieldKey}`}
        value={pathToCascaderValue(ref?.$ref.path ?? [])}
        onValueChange={(next) => {
          const path = cascaderValueToPath(next);
          const stepId = selectedSource?.stepId;
          if (!stepId) return;
          onChange({
            ...value,
            [fieldKey]: { $ref: { fromStepId: stepId, path } },
          });
        }}
        options={pathTree}
        disabled={disabled || !selectedSource}
      />
      {ref && (
        <p className="text-xs text-muted">
          {formatContextRefLabel(ref, sources.find((s) => s.stepId === ref.$ref.fromStepId)?.label)}
          <span className="text-faint"> · 期望 {schemaBasicTypeLabel(expectedProp)}</span>
        </p>
      )}
      {displayError && <p className="text-xs text-failed">{displayError}</p>}
      {sources.length === 0 && (
        <p className="text-xs text-faint">
          暂无可引用源（需声明 State Schema，或依赖声明了 resultSchema 的祖先步骤）
        </p>
      )}
    </div>
  );
}

function renderField(
  key: string,
  prop: JsonSchemaProperty,
  value: Record<string, unknown>,
  errors: Record<string, string>,
  onChange: (value: Record<string, unknown>) => void,
  disabled: boolean | undefined,
  referenceSources: ConfigReferenceSource[] | undefined,
) {
  const label = humanizeFieldLabel(key, prop.description);
  const typeLabel = schemaBasicTypeLabel(prop);
  const error = errors[key];
  const fieldValue = value[key];
  const sources = referenceSources ?? [];
  const canReference = sources.length > 0;
  const isRef = isContextRef(fieldValue);

  const body = isRef ? (
    <ReferenceFieldEditor
      fieldKey={key}
      expectedProp={prop}
      value={value}
      sources={sources}
      error={error}
      onChange={onChange}
      disabled={disabled}
    />
  ) : (
    renderLiteralField(key, prop, value, errors, onChange, disabled, {
      hideOuterLabel: true,
    })
  );
  return (
    <div key={key} className="mb-3 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium text-fg truncate">{label}</span>
          <span className="shrink-0 text-[10px] tracking-wide text-faint font-mono">
            {typeLabel}
          </span>
        </div>
        {canReference && (
          <FieldModeToggle
            isRef={isRef}
            disabled={disabled}
            onToggle={(mode) => {
              if (mode === 'ref') {
                const first = sources[0];
                onChange({
                  ...value,
                  [key]: { $ref: { fromStepId: first.stepId, path: [] } },
                });
                return;
              }
              onChange({ ...value, [key]: literalFallbackForProp(prop) });
            }}
          />
        )}
      </div>
      {isRef ? body : prop.type === 'boolean' ? body : <div className="[&>*]:mb-0">{body}</div>}
    </div>
  );
}

export function JsonSchemaForm({
  schema,
  value,
  errors = {},
  onChange,
  disabled,
  referenceSources,
}: JsonSchemaFormProps) {
  const properties = schema.properties ?? {};
  const entries = Object.entries(properties);

  if (entries.length === 0) {
    return <p className="text-sm text-faint">该插件未声明可配置字段。</p>;
  }

  return (
    <div className="space-y-1">
      {entries.map(([key, prop]) =>
        renderField(key, prop, value, errors, onChange, disabled, referenceSources),
      )}
    </div>
  );
}
