/** 插件 config JSON Schema 子集（由 Zod → zod-to-json-schema 生成） */
export interface JsonSchemaProperty {
  type?: string;
  enum?: Array<string | number | boolean>;
  default?: unknown;
  minLength?: number;
  description?: string;
}

export interface JsonObjectSchema {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export type { PluginConfigSchemaResponse } from '../../types';
