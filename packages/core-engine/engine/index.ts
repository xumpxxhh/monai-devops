/**
 * 引擎门面
 * @module engine
 */

import type { PluginDefinition } from '@monai-devops/plugin-sdk';
import { createPluginManager } from '../plugin/index.js';
import {
  createWorkflowExecutor,
  type WorkflowDefinition,
  type WorkflowRunResult,
  type ExecutionContext,
  type WorkflowStep,
} from '../executor/index.js';
import {
  createTaskScheduler,
  type SchedulerOptions,
  type ScheduleResult,
} from '../scheduler/index.js';
import {
  createResourceManager,
  type Resource,
  type ResourcePoolOptions,
} from '../resource/index.js';
import { createResourceStepScheduler } from '../resource-scheduler/index.js';
import type { WorkflowObserver } from '../observer/index.js';

export interface EngineOptions {
  plugins?: PluginDefinition[];
  maxParallelSteps?: number;
  failFast?: boolean;
  scheduler?: SchedulerOptions;
  resources?: ResourcePoolOptions;
  /** 引擎启动时预注册的资源（步骤声明 resourceType 前须确保池中有对应类型） */
  initialResources?: Resource[];
  /** default 资源池固定槽位数（未写 resourceType 的步骤使用） */
  defaultPoolSize?: number;
  observer?: WorkflowObserver;
}

function stepResourceKey(runId: string, stepId: string): string {
  return `${runId}:${stepId}`;
}

const DEFAULT_RESOURCE_TYPE = 'default';

function getResourceType(step: WorkflowStep): string {
  const resourceType = step.config.resourceType;
  if (typeof resourceType === 'string' && resourceType.length > 0) {
    return resourceType;
  }
  return DEFAULT_RESOURCE_TYPE;
}

export function createEngine(options: EngineOptions = {}) {
  const plugins = createPluginManager();
  const scheduler = createTaskScheduler(options.scheduler);

  const schedulerHolder: { notify?: (type: string) => void } = {};
  const resources = createResourceManager({
    autoCleanup: false,
    ...options.resources,
    onResourceAvailable: (type) => schedulerHolder.notify?.(type),
  });
  const resourceScheduler = createResourceStepScheduler({ resourceManager: resources });
  schedulerHolder.notify = (type) => resourceScheduler.notifyResourceAvailable(type);

  const defaultPoolSize = options.defaultPoolSize ?? 5;
  for (let i = 0; i < defaultPoolSize; i++) {
    resources.registerResource({
      id: `${DEFAULT_RESOURCE_TYPE}-${i}`,
      type: DEFAULT_RESOURCE_TYPE,
      name: `${DEFAULT_RESOURCE_TYPE}-slot-${i}`,
      status: 'available',
    });
  }

  if (options.initialResources) {
    for (const resource of options.initialResources) {
      resources.registerResource(resource);
    }
  }

  const releaseHandles = new Map<string, () => void>();

  const executor = createWorkflowExecutor({
    maxParallelSteps: options.maxParallelSteps ?? 1,
    failFast: options.failFast ?? true,
    observer: options.observer,
    pluginExecutor: (name, config, ctx) => plugins.executePlugin(name, config, ctx),
    onStepStart: async (step, context, meta) => {
      const resourceType = getResourceType(step);

      const runId =
        typeof context.runId === 'string' && context.runId.length > 0 ? context.runId : '';
      if (!runId) return;
      const priority = step.priority ?? context.priority ?? 0;
      const id = stepResourceKey(runId, step.id);
      const { release } = await resourceScheduler.acquire({
        id,
        runId,
        resourceType,
        priority,
        onQueued: meta
          ? () =>
              options.observer?.onEvent?.({
                type: 'step:queued',
                meta,
                step,
                resourceType,
                priority,
              })
          : undefined,
      });

      releaseHandles.set(id, release);
    },
    onStepComplete: (step, _result, context) => {
      const runId = typeof context.runId === 'string' ? context.runId : '';
      if (!runId) return;
      const key = stepResourceKey(runId, step.id);
      const release = releaseHandles.get(key);
      if (release) {
        release();
        releaseHandles.delete(key);
      }
    },
    onStepError: (step, _error, context) => {
      const runId = typeof context.runId === 'string' ? context.runId : '';
      if (!runId) return;
      const key = stepResourceKey(runId, step.id);
      const release = releaseHandles.get(key);
      if (release) {
        release();
        releaseHandles.delete(key);
      }
    },
    onWorkflowAbort: (runId) => {
      resourceScheduler.cancelByRunId(runId);
    },
  });

  if (options.plugins) {
    plugins.registerPlugins(options.plugins);
  }

  async function runWorkflow(
    workflow: WorkflowDefinition,
    context: Partial<ExecutionContext> = {},
  ): Promise<WorkflowRunResult> {
    return executor.executeWorkflow(workflow, context);
  }

  function scheduleWorkflow(
    workflow: WorkflowDefinition,
    context: Partial<ExecutionContext> = {},
  ): Promise<ScheduleResult> {
    const taskId = `workflow-${workflow.id}-${Date.now()}`;
    return scheduler.scheduleTask({
      id: taskId,
      name: workflow.name,
      priority: 0,
      createdAt: new Date(),
      execute: () => runWorkflow(workflow, context),
    });
  }

  function destroy(): void {
    resourceScheduler.destroy();
    resources.destroy();
    executor.clearHistory();
    releaseHandles.clear();
  }

  return {
    runWorkflow,
    scheduleWorkflow,
    registerPlugin: plugins.registerPlugin,
    registerPlugins: plugins.registerPlugins,
    unregisterPlugin: plugins.unregisterPlugin,
    getPlugin: plugins.getPlugin,
    getPlugins: plugins.getAllPlugins,
    getPluginNames: plugins.getPluginNames,
    hasPlugin: plugins.hasPlugin,
    getResourceManager: () => resources,
    registerResource: resources.registerResource,
    getResourceScheduler: () => resourceScheduler,
    getScheduler: () => scheduler,
    getExecutor: () => executor,
    destroy,
  };
}
