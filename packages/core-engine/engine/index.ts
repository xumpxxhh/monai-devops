/**
 * 引擎门面
 * @module engine
 */

import type { PluginDefinition } from "plugin-sdk";
import { StepExecutionError, StepFailureKinds } from "../errors";
import { createPluginManager } from "../plugin";
import {
  createWorkflowExecutor,
  type WorkflowDefinition,
  type WorkflowRunResult,
  type ExecutionContext,
} from "../executor";
import {
  createTaskScheduler,
  type SchedulerOptions,
  type ScheduleResult,
} from "../scheduler";
import {
  createResourceManager,
  type ResourcePoolOptions,
} from "../resource";
import type { WorkflowObserver } from "../observer";

export interface EngineOptions {
  plugins?: PluginDefinition[];
  maxParallelSteps?: number;
  failFast?: boolean;
  scheduler?: SchedulerOptions;
  resources?: ResourcePoolOptions;
  observer?: WorkflowObserver;
}

export function createEngine(options: EngineOptions = {}) {
  const plugins = createPluginManager();
  const resources = createResourceManager(options.resources);
  const scheduler = createTaskScheduler(options.scheduler);

  const stepResources = new Map<string, string>();

  const executor = createWorkflowExecutor({
    maxParallelSteps: options.maxParallelSteps ?? 1,
    failFast: options.failFast ?? true,
    observer: options.observer,
    pluginExecutor: (name, config, ctx) =>
      plugins.executePlugin(name, config, ctx),
    onStepStart: (step) => {
      const resourceType = step.config.resourceType;
      if (typeof resourceType === "string" && resourceType.length > 0) {
        const allocated = resources.allocateResource(resourceType);
        if (!allocated) {
          throw new StepExecutionError(
            `步骤 ${step.id} 无法分配资源类型: ${resourceType}`,
            StepFailureKinds.RESOURCE,
          );
        }
        stepResources.set(step.id, allocated.id);
      }
    },
    onStepComplete: (step) => {
      const resourceId = stepResources.get(step.id);
      if (resourceId) {
        resources.releaseResource(resourceId);
        stepResources.delete(step.id);
      }
    },
    onStepError: (step) => {
      const resourceId = stepResources.get(step.id);
      if (resourceId) {
        resources.releaseResource(resourceId);
        stepResources.delete(step.id);
      }
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
    resources.destroy();
    executor.clearHistory();
    stepResources.clear();
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
    getScheduler: () => scheduler,
    getExecutor: () => executor,
    destroy,
  };
}
