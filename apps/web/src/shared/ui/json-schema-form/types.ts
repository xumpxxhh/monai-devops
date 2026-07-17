/** 插件 config / result JSON Schema 子集（由 Zod → zod-to-json-schema 生成） */
export interface JsonSchemaProperty {
  type?: string;
  enum?: Array<string | number | boolean>;
  default?: unknown;
  minLength?: number;
  description?: string;
  properties?: Record<string, JsonSchemaProperty>;
  items?: JsonSchemaProperty;
  oneOf?: JsonSchemaProperty[];
  anyOf?: JsonSchemaProperty[];
}

export interface JsonObjectSchema {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchemaProperty;
  oneOf?: JsonSchemaProperty[];
  anyOf?: JsonSchemaProperty[];
}

export type { PluginConfigSchemaResponse, PluginResultSchemaResponse } from '../../types';

export type ContextRefValue = {
  $ref: {
    fromStepId: string;
    path: string[];
  };
};

export type ConfigReferenceSource = {
  stepId: string;
  label: string;
  plugin: string;
  resultSchema: JsonObjectSchema;
};
