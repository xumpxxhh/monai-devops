import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { JsonSchemaForm } from '../ui/json-schema-form/JsonSchemaForm';
import { mergeWithDefaults } from '../ui/json-schema-form/schema-utils';
import { usePluginConfigSchema, type ValidateResult } from './usePluginConfigSchema';

export interface PluginConfigFormHandle {
  validate: () => ValidateResult;
  ready: boolean;
}

interface PluginConfigFormProps {
  pluginName: string;
  value: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  onReadyChange?: (ready: boolean) => void;
  disabled?: boolean;
}

export const PluginConfigForm = forwardRef<PluginConfigFormHandle, PluginConfigFormProps>(
  function PluginConfigForm({ pluginName, value, onChange, onReadyChange, disabled }, ref) {
    const { schema, loading, loadError, fieldErrors, setFieldErrors, validate, ready } =
      usePluginConfigSchema(pluginName);

    const syncedKeyRef = useRef<string | null>(null);

    useEffect(() => {
      onReadyChange?.(ready);
    }, [ready, onReadyChange]);

    useEffect(() => {
      if (!schema) return;
      const syncKey = pluginName;
      if (syncedKeyRef.current === syncKey) return;
      syncedKeyRef.current = syncKey;

      const merged = mergeWithDefaults(schema, value);
      if (JSON.stringify(merged) !== JSON.stringify(value)) {
        onChange(merged);
      }
      setFieldErrors({});
    }, [pluginName, schema, value, onChange, setFieldErrors]);

    useImperativeHandle(
      ref,
      () => ({
        validate: () => validate(value),
        ready,
      }),
      [validate, value, ready],
    );

    if (loading) {
      return <p className="text-sm text-faint">加载配置表单…</p>;
    }

    if (loadError) {
      return <p className="text-sm text-failed">{loadError}</p>;
    }

    if (!schema) {
      return null;
    }

    return (
      <JsonSchemaForm
        schema={schema}
        value={value}
        errors={fieldErrors}
        onChange={(next) => {
          setFieldErrors({});
          onChange(next);
        }}
        disabled={disabled}
      />
    );
  },
);
