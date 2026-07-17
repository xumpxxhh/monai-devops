import { Field, Input, Select, Cascader, Checkbox } from '../form';
import type { ConfigReferenceSource, JsonObjectSchema } from './types';
import { humanizeFieldLabel, isSensitiveField } from './schema-utils';
import {
  RESULT_ROOT_VALUE,
  buildResultFieldTree,
  cascaderValueToPath,
  formatContextRefLabel,
  isContextRef,
  pathToCascaderValue,
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

function renderLiteralField(
  key: string,
  prop: NonNullable<JsonObjectSchema['properties']>[string],
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
      <Field key={key} label={showLabel ? label : undefined} htmlFor={fieldId} error={error}>
        <Select
          id={fieldId}
          value={fieldValue !== undefined ? String(fieldValue) : ''}
          onValueChange={(next) => onChange({ ...value, [key]: next })}
          options={selectOptions}
          disabled={disabled}
        />
      </Field>
    );
  }

  if (prop.type === 'boolean') {
    return (
      <Field key={key} error={error} className="mb-3">
        <Checkbox
          id={fieldId}
          checked={Boolean(fieldValue)}
          onCheckedChange={(checked) => onChange({ ...value, [key]: checked })}
          disabled={disabled}
          label={label}
        />
      </Field>
    );
  }

  if (prop.type === 'number' || prop.type === 'integer') {
    return (
      <Field key={key} label={showLabel ? label : undefined} htmlFor={fieldId} error={error}>
        <Input
          id={fieldId}
          type="number"
          value={fieldValue !== undefined ? String(fieldValue) : ''}
          onChange={(e) => onChange({ ...value, [key]: e.target.value })}
          disabled={disabled}
        />
      </Field>
    );
  }

  return (
    <Field key={key} label={showLabel ? label : undefined} htmlFor={fieldId} error={error}>
      <Input
        id={fieldId}
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
  value,
  sources,
  error,
  onChange,
  disabled,
}: {
  fieldKey: string;
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
        </p>
      )}
      {error && <p className="text-xs text-failed">{error}</p>}
      {sources.length === 0 && (
        <p className="text-xs text-faint">暂无可引用上游（需依赖声明了 resultSchema 的祖先步骤）</p>
      )}
    </div>
  );
}

function renderField(
  key: string,
  prop: NonNullable<JsonObjectSchema['properties']>[string],
  value: Record<string, unknown>,
  errors: Record<string, string>,
  onChange: (value: Record<string, unknown>) => void,
  disabled: boolean | undefined,
  referenceSources: ConfigReferenceSource[] | undefined,
) {
  const label = humanizeFieldLabel(key, prop.description);
  const error = errors[key];
  const fieldValue = value[key];
  const sources = referenceSources ?? [];
  const canReference = sources.length > 0;
  const isRef = isContextRef(fieldValue);

  const body = isRef ? (
    <ReferenceFieldEditor
      fieldKey={key}
      value={value}
      sources={sources}
      error={error}
      onChange={onChange}
      disabled={disabled}
    />
  ) : (
    renderLiteralField(key, prop, value, errors, onChange, disabled, {
      hideOuterLabel: canReference,
    })
  );

  if (!canReference) {
    return body;
  }

  return (
    <div key={key} className="mb-3 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-fg">{label}</span>
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
            const fallback =
              prop.default !== undefined
                ? prop.default
                : prop.enum?.[0] !== undefined
                  ? prop.enum[0]
                  : prop.type === 'boolean'
                    ? false
                    : '';
            onChange({ ...value, [key]: fallback });
          }}
        />
      </div>
      {isRef ? body : <div className="[&>*]:mb-0">{body}</div>}
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
