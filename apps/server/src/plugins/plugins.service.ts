import { randomUUID } from 'node:crypto';
import { HttpException, HttpStatus, Injectable, type MessageEvent } from '@nestjs/common';
import type { PluginConfig } from '@monai-devops/plugin-sdk';
import { Observable } from 'rxjs';
import { EngineService } from '../engine/engine.service.js';
import {
  serializeExecutionResult,
  serializeWorkflowEvent,
  type SerializedExecutionResult,
  type SerializedWorkflowLifecycleEvent,
} from '../common/serialization/serialize-workflow-event.js';

export type PluginDryRunSseMessage =
  | { type: 'log'; event: SerializedWorkflowLifecycleEvent }
  | { type: 'done'; result: SerializedExecutionResult }
  | { type: 'error'; message: string };

@Injectable()
export class PluginsService {
  constructor(private readonly engineService: EngineService) {}

  list() {
    return this.engineService.getPlugins();
  }

  get(name: string) {
    const plugin = this.engineService.getPlugin(name);
    if (!plugin) {
      throw new HttpException('插件不存在', HttpStatus.NOT_FOUND);
    }
    return plugin;
  }

  getConfigSchema(name: string) {
    const schema = this.engineService.getPluginConfigJsonSchema(name);
    if (!schema) {
      throw new HttpException('插件不存在或未声明 configSchema', HttpStatus.NOT_FOUND);
    }
    return { name, configJsonSchema: schema };
  }

  dryRun(name: string, config: PluginConfig): Observable<MessageEvent> {
    if (!this.engineService.getPlugin(name)) {
      throw new HttpException('插件不存在', HttpStatus.NOT_FOUND);
    }

    const runId = `dry-run-${randomUUID()}`;

    return new Observable((subscriber) => {
      const unsubscribe = this.engineService.onEvent((event) => {
        if (event.meta.runId !== runId || event.type !== 'plugin:log') {
          return;
        }

        const message: PluginDryRunSseMessage = {
          type: 'log',
          event: serializeWorkflowEvent(event),
        };
        subscriber.next({ data: message });
      });

      void this.engineService
        .dryRunPlugin(name, config, { runId })
        .then((result) => {
          const message: PluginDryRunSseMessage = {
            type: 'done',
            result: serializeExecutionResult(result),
          };
          subscriber.next({ data: message });
          subscriber.complete();
        })
        .catch((error: unknown) => {
          const message: PluginDryRunSseMessage = {
            type: 'error',
            message: error instanceof Error ? error.message : '试运行失败',
          };
          subscriber.next({ data: message });
          subscriber.complete();
        })
        .finally(() => {
          unsubscribe();
        });
    });
  }
}
