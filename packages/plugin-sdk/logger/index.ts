/**
 * 插件执行日志
 * @module logger
 */

import type { PluginContext } from '../types/index.js';
import { getContext } from '../base/index.js';

export type PluginLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type PluginLogStream = 'stdout' | 'stderr';

export interface PluginLogEntry {
  level: PluginLogLevel;
  message: string;
  timestamp: number;
  data?: Record<string, unknown>;
  stream?: PluginLogStream;
}

export interface PluginLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  append(chunk: string, stream?: PluginLogStream): void;
}

export const PluginContextKeys = {
  logger: 'logger',
} as const;

export const noopLogger: PluginLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  append() {},
};

export function getLogger(context: PluginContext): PluginLogger {
  return getContext<PluginLogger>(context, PluginContextKeys.logger) ?? noopLogger;
}
