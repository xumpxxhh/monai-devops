import { Field, Input, Select, Checkbox } from '../form';
import type { JsonObjectSchema } from './types';
import { humanizeFieldLabel, isSensitiveField } from './schema-utils';

interface JsonSchemaFormProps {
  schema: JsonObjectSchema;
  value: Record<string, unknown>;
  errors?: Record<string, string>;
  onChange: (value: Record<string, unknown>) => void;
  disabled?: boolean;
}

function renderField(
  key: string,
  prop: NonNullable<JsonObjectSchema['properties']>[string],
  value: Record<string, unknown>,
  errors: Record<string, string>,
  onChange: (value: Record<string, unknown>) => void,
  disabled?: boolean,
) {
  const fieldId = `schema-field-${key}`;
  const label = humanizeFieldLabel(key, prop.description);
  const error = errors[key];
  const fieldValue = value[key];

  if (prop.enum?.length) {
    const options = prop.enum.map((item) => ({
      value: String(item),
      label: String(item),
    }));
    return (
      <Field key={key} label={label} htmlFor={fieldId} error={error}>
        <Select
          id={fieldId}
          value={fieldValue !== undefined ? String(fieldValue) : ''}
          onValueChange={(next) => onChange({ ...value, [key]: next })}
          options={options}
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
      <Field key={key} label={label} htmlFor={fieldId} error={error}>
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
    <Field key={key} label={label} htmlFor={fieldId} error={error}>
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

export function JsonSchemaForm({
  schema,
  value,
  errors = {},
  onChange,
  disabled,
}: JsonSchemaFormProps) {
  const properties = schema.properties ?? {};
  const entries = Object.entries(properties);

  if (entries.length === 0) {
    return <p className="text-sm text-faint">该插件未声明可配置字段。</p>;
  }

  return (
    <div className="space-y-1">
      {entries.map(([key, prop]) => renderField(key, prop, value, errors, onChange, disabled))}
    </div>
  );
}
