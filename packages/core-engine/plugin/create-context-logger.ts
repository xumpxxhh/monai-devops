/**
 * 将 PluginLogger 桥接到 observer emit（串行队列 + flush）
 * @module plugin/create-context-logger
 */

import type { PluginLogEntry, PluginLogger, PluginLogStream } from '@monai-devops/plugin-sdk';

export interface CreateContextLoggerOptions {
  emit: (entry: PluginLogEntry) => void | Promise<void>;
}

export interface ContextLogger {
  logger: PluginLogger;
  /** 等待已入队的日志全部 emit 完成；observer 抛错时 reject */
  flush: () => Promise<void>;
}

export function createContextLogger({ emit }: CreateContextLoggerOptions): ContextLogger {
  let tail: Promise<void> = Promise.resolve();

  function enqueue(entry: PluginLogEntry): void {
    tail = tail.then(() => Promise.resolve(emit(entry)));
  }

  const logger: PluginLogger = {
    debug(message, data) {
      enqueue({ level: 'debug', message, timestamp: Date.now(), data });
    },
    info(message, data) {
      enqueue({ level: 'info', message, timestamp: Date.now(), data });
    },
    warn(message, data) {
      enqueue({ level: 'warn', message, timestamp: Date.now(), data });
    },
    error(message, data) {
      enqueue({ level: 'error', message, timestamp: Date.now(), data });
    },
    append(chunk, stream: PluginLogStream = 'stdout') {
      enqueue({
        level: 'info',
        message: chunk,
        timestamp: Date.now(),
        stream,
      });
    },
  };

  return {
    logger,
    flush: () => tail,
  };
}
