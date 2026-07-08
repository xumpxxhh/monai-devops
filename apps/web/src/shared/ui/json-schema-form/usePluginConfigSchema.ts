import { useCallback, useEffect, useState } from 'react';
import { pluginsApi } from '../../api/misc';
import type { JsonObjectSchema } from './types';
import { coerceValidatedValues, mergeWithDefaults, validateAgainstSchema } from './schema-utils';

const EMPTY_INITIAL: Record<string, unknown> = {};

let schemaMapPromise: Promise<Map<string, JsonObjectSchema | null>> | null = null;

function loadPluginConfigSchemaMap() {
  schemaMapPromise ??= pluginsApi
    .listConfigSchemas()
    .then(
      (items) =>
        new Map(items.map((item) => [item.name, item.configJsonSchema as JsonObjectSchema | null])),
    );
  return schemaMapPromise;
}

/** 供页面并行预加载，与 hook 共享同一次请求 */
export function preloadPluginConfigSchemas() {
  return loadPluginConfigSchemaMap();
}

export interface UsePluginConfigSchemaOptions {
  enabled?: boolean;
  initialValue?: Record<string, unknown>;
}

export type ValidateResult =
  | { ok: true; errors: Record<string, string>; config: Record<string, unknown> }
  | { ok: false; errors: Record<string, string>; config: Record<string, unknown> };

export function usePluginConfigSchema(
  pluginName: string,
  { enabled = true, initialValue }: UsePluginConfigSchemaOptions = {},
) {
  const [schema, setSchema] = useState<JsonObjectSchema | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [formValue, setFormValue] = useState<Record<string, unknown>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const resolvedInitial = initialValue ?? EMPTY_INITIAL;
  const initialValueKey = JSON.stringify(resolvedInitial);

  useEffect(() => {
    if (!enabled) return;

    const initial = JSON.parse(initialValueKey) as Record<string, unknown>;
    let cancelled = false;
    /* eslint-disable react-hooks/set-state-in-effect -- 加载配置 Schema 时设置加载状态 */
    setLoading(true);
    setLoadError('');
    setFieldErrors({});
    /* eslint-enable react-hooks/set-state-in-effect */
    loadPluginConfigSchemaMap()
      .then((map) => {
        if (cancelled) return;
        if (!map.has(pluginName)) {
          setSchema(null);
          setLoadError('插件不存在');
          return;
        }
        const jsonSchema = map.get(pluginName) ?? null;
        if (jsonSchema === null) {
          setSchema(null);
          setLoadError('该插件无可配置项');
          return;
        }
        setSchema(jsonSchema);
        setFormValue(mergeWithDefaults(jsonSchema, initial));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setSchema(null);
        setLoadError(error instanceof Error ? error.message : '加载配置 Schema 失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, pluginName, initialValueKey]);

  const validate = useCallback(
    (value?: Record<string, unknown>): ValidateResult => {
      const current = value ?? formValue;
      if (!schema) {
        return { ok: false, errors: {}, config: {} };
      }

      const errors = validateAgainstSchema(schema, current);
      setFieldErrors(errors);

      if (Object.keys(errors).length > 0) {
        return { ok: false, errors, config: {} };
      }

      return {
        ok: true,
        errors: {},
        config: coerceValidatedValues(schema, current),
      };
    },
    [schema, formValue],
  );

  const ready = !loading && !loadError && schema !== null;

  return {
    schema,
    loading,
    loadError,
    formValue,
    setFormValue,
    fieldErrors,
    setFieldErrors,
    validate,
    ready,
  };
}
