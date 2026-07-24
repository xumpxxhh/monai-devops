import { Global, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PluginConfig, ZodType } from '@monai-devops/plugin-sdk';
import {
  BUILTIN_STEP_KIND_DEFINITIONS,
  createEngine,
  type EmbeddedRunHooks,
  type ExecuteWorkflowCallOptions,
  type ExecutionContext,
  type ExecutionResult,
  type ResolveWorkflow,
  type WorkflowDefinition,
  type WorkflowLifecycleEvent,
  type WorkflowRunResult,
  type WorkflowStep,
} from '@monai-devops/core-engine';
import { registeredPlugins } from '../plugins/plugin-registry.js';
import { toPluginConfigJsonSchema } from '../plugins/plugin-config-schema.js';
import { toPluginResultJsonSchema } from '../plugins/plugin-result-schema.js';
import {
  validateWorkflowDefinition,
  type ValidateWorkflowDefinitionOptions,
} from '../common/validation/validate-workflow.js';

type EngineInstance = ReturnType<typeof createEngine>;
type EventHandler = (event: WorkflowLifecycleEvent) => void | Promise<void>;

@Global()
@Injectable()
export class EngineService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EngineService.name);
  private engine!: EngineInstance;
  private ready = false;
  private readonly eventHandlers = new Set<EventHandler>();
  private resolveWorkflowImpl?: ResolveWorkflow;
  private embeddedRunHooksImpl?: EmbeddedRunHooks;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const maxParallelSteps = this.config.get<number>('MAX_PARALLEL_STEPS', 2);
    const resourcePoolSize = this.config.get<number>('RESOURCE_POOL_SIZE', 5);
    const maxNestingDepth = this.config.get<number>('MAX_NESTING_DEPTH', 3);

    this.engine = createEngine({
      plugins: registeredPlugins,
      maxParallelSteps,
      defaultPoolSize: resourcePoolSize,
      maxNestingDepth,
      resolveWorkflow: (importId) => {
        if (!this.resolveWorkflowImpl) {
          return Promise.reject(new Error(`未配置 resolveWorkflow，无法解析 importId=${importId}`));
        }
        return this.resolveWorkflowImpl(importId);
      },
      embeddedRunHooks: {
        onChildRunStart: async (childRunId, childDefinition, ctx) => {
          await this.embeddedRunHooksImpl?.onChildRunStart(childRunId, childDefinition, ctx);
        },
        onChildRunFinished: async (childRunId, result) => {
          await this.embeddedRunHooksImpl?.onChildRunFinished(childRunId, result);
        },
      },
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
      `Engine initialized (maxParallelSteps=${maxParallelSteps}, resourcePoolSize=${resourcePoolSize}, maxNestingDepth=${maxNestingDepth})`,
    );
  }

  /** 由 Workflows / Runs 模块在启动后注入查库实现 */
  setResolveWorkflow(resolve: ResolveWorkflow): void {
    this.resolveWorkflowImpl = resolve;
  }

  /** 由 RunManager 注入子 run 落表回调 */
  setEmbeddedRunHooks(hooks: EmbeddedRunHooks): void {
    this.embeddedRunHooksImpl = hooks;
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

  async validateWorkflow(
    workflow: WorkflowDefinition,
    options: Omit<ValidateWorkflowDefinitionOptions, 'resolvePluginResultSchema'> = {},
  ): Promise<void> {
    await validateWorkflowDefinition(workflow, {
      ...options,
      resolvePluginResultSchema: (name) => this.resolvePluginResultSchema(name),
      resolveWorkflow: options.resolveWorkflow ?? this.resolveWorkflowImpl,
    });
  }

  runWorkflow(
    workflowRunId: string,
    workflow: WorkflowDefinition,
    context: Partial<ExecutionContext> = {},
    callOptions?: ExecuteWorkflowCallOptions,
  ): Promise<WorkflowRunResult> {
    return this.engine.runWorkflow(workflowRunId, workflow, context, callOptions);
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
      hasResultSchema: Boolean(plugin.resultSchema),
    }));
  }

  getStepKinds() {
    return BUILTIN_STEP_KIND_DEFINITIONS.map((def) => ({
      kind: def.kind,
      label: def.label,
      description: def.description,
      configSchema: def.configSchema,
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
      hasResultSchema: Boolean(plugin.resultSchema),
    };
  }

  resolvePluginResultSchema(name: string): ZodType | undefined {
    return this.engine.getPlugin(name)?.resultSchema;
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

  getPluginResultJsonSchema(name: string): Record<string, unknown> | undefined {
    const plugin = this.engine.getPlugin(name);
    if (!plugin?.resultSchema) return undefined;
    return toPluginResultJsonSchema(plugin.resultSchema);
  }

  getAllPluginResultJsonSchemas() {
    return this.engine.getPlugins().map((plugin) => ({
      name: plugin.name,
      resultJsonSchema: plugin.resultSchema ? toPluginResultJsonSchema(plugin.resultSchema) : null,
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
