import { Global, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PluginConfig } from '@monai-devops/plugin-sdk';
import {
  createEngine,
  type ExecutionContext,
  type ExecutionResult,
  type WorkflowDefinition,
  type WorkflowLifecycleEvent,
  type WorkflowRunResult,
  type WorkflowStep,
} from '@monai-devops/core-engine';
import { registeredPlugins } from '../plugins/plugin-registry.js';
import { toPluginConfigJsonSchema } from '../plugins/plugin-config-schema.js';
import { validateWorkflowDefinition } from '../common/validation/validate-workflow.js';

type EngineInstance = ReturnType<typeof createEngine>;
type EventHandler = (event: WorkflowLifecycleEvent) => void | Promise<void>;

@Global()
@Injectable()
export class EngineService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EngineService.name);
  private engine!: EngineInstance;
  private ready = false;
  private readonly eventHandlers = new Set<EventHandler>();

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const maxParallelSteps = this.config.get<number>('MAX_PARALLEL_STEPS', 2);
    const resourcePoolSize = this.config.get<number>('RESOURCE_POOL_SIZE', 5);

    this.engine = createEngine({
      plugins: registeredPlugins,
      maxParallelSteps,
      defaultPoolSize: resourcePoolSize,
      observer: {
        onEvent: async (event) => {
          for (const handler of this.eventHandlers) {
            await handler(event);
          }
        },
      },
    });

    this.ready = true;
    this.logger.log(
      `Engine initialized (maxParallelSteps=${maxParallelSteps}, resourcePoolSize=${resourcePoolSize})`,
    );
  }

  onModuleDestroy(): void {
    if (this.engine) {
      void this.engine.destroy().finally(() => {
        this.ready = false;
        this.logger.log('Engine destroyed');
      });
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  validateWorkflow(workflow: WorkflowDefinition): void {
    validateWorkflowDefinition(workflow);
  }

  runWorkflow(
    workflowRunId: string,
    workflow: WorkflowDefinition,
    context: Partial<ExecutionContext> = {},
  ): Promise<WorkflowRunResult> {
    return this.engine.runWorkflow(workflowRunId, workflow, context);
  }

  dryRunPlugin(
    workflowRunId: string,
    pluginName: string,
    config: PluginConfig,
    context: Partial<ExecutionContext> = {},
  ): Promise<ExecutionResult> {
    const step: WorkflowStep = {
      id: 'dry-run',
      name: 'Dry Run',
      plugin: pluginName,
      config,
    };

    const traceId = typeof context.traceId === 'string' ? context.traceId : undefined;

    const executionContext: ExecutionContext = {
      workflowId: 'dry-run',
      stepId: step.id,
      runId: workflowRunId,
      traceId,
      priority: context.priority,
      previousResults: context.previousResults,
      artifacts: context.artifacts,
    };

    return this.engine.getExecutor().executeStep(workflowRunId, step, executionContext, {
      workflowId: 'dry-run',
      traceId,
      context: executionContext,
    });
  }

  getPlugins() {
    return this.engine.getPlugins().map((plugin) => ({
      name: plugin.name,
      version: plugin.version,
      description: plugin.description,
      hasConfigSchema: Boolean(plugin.configSchema),
    }));
  }

  getPlugin(name: string) {
    const plugin = this.engine.getPlugin(name);
    if (!plugin) return undefined;
    return {
      name: plugin.name,
      version: plugin.version,
      description: plugin.description,
      hasConfigSchema: Boolean(plugin.configSchema),
    };
  }

  getPluginConfigJsonSchema(name: string): Record<string, unknown> | undefined {
    const plugin = this.engine.getPlugin(name);
    if (!plugin?.configSchema) return undefined;
    return toPluginConfigJsonSchema(plugin.configSchema);
  }

  getAllPluginConfigJsonSchemas() {
    return this.engine.getPlugins().map((plugin) => ({
      name: plugin.name,
      configJsonSchema: plugin.configSchema ? toPluginConfigJsonSchema(plugin.configSchema) : null,
    }));
  }

  getResources() {
    return this.engine
      .getResourceManager()
      .getAllResources()
      .map((resource) => ({
        id: resource.id,
        type: resource.type,
        name: resource.name,
        status: resource.status,
      }));
  }

  getQueueStatus() {
    return this.engine.getResourceWaitQueue().getQueueStatus();
  }

  cancelRun(workflowRunId: string, mode?: 'best-effort' | 'hard') {
    return this.engine.cancelRun(workflowRunId, mode ? { mode } : undefined);
  }

  pauseRun(workflowRunId: string, options?: { waitInFlight?: boolean; abortInFlight?: boolean }) {
    return this.engine.pauseRun(workflowRunId, options);
  }

  resumeRun(workflowRunId: string) {
    return this.engine.resumeRun(workflowRunId);
  }

  getRunStatus(workflowRunId: string) {
    return this.engine.getRunStatus(workflowRunId);
  }
  getPluginCount(): number {
    return this.engine.getPlugins().length;
  }
}
