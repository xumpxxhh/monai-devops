/**
 * 插件执行日志
 * @module logger
 */

import type { PluginContext } from '../types/index.js';
import { PluginCancelledError } from '../types/index.js';
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
  signal: 'signal',
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

export function getAbortSignal(context: PluginContext): AbortSignal | undefined {
  return getContext<AbortSignal>(context, PluginContextKeys.signal);
}

export function isAborted(context: PluginContext): boolean {
  return getAbortSignal(context)?.aborted ?? false;
}

export function throwIfAborted(context: PluginContext): void {
  if (isAborted(context)) {
    throw new PluginCancelledError();
  }
}

/**
 * 可中断的异步等待；signal abort 时以 PluginCancelledError 拒绝
 */
export function sleep(ms: number, context: PluginContext): Promise<void> {
  const signal = getAbortSignal(context);
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  if (signal.aborted) {
    return Promise.reject(new PluginCancelledError());
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new PluginCancelledError());
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}
