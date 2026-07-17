/**
 * 引擎门面：将 plugin / executor / scheduler / resource 模块按默认拓扑接线。
 *
 * 调用方推荐只依赖本模块的 createEngine，而非直接拼装子模块。
 * 编排与 Run 控制逻辑在 executor；本层额外负责：
 * - 步骤级资源 acquire/release（onStepStart / onStepComplete 钩子）
 * - workflow 级任务入队（scheduleWorkflow）
 * - cancelRun 时联动撤销调度队列中的未开始任务
 *
 * @module engine
 */

import type { PluginDefinition } from '@monai-devops/plugin-sdk';
import { createPluginManager } from '../plugin/index.js';
import {
  createWorkflowExecutor,
  assertValidWorkflowRunId,
  type WorkflowDefinition,
  type WorkflowRunResult,
  type ExecutionContext,
  type WorkflowStep,
  type CancelRunOptions,
  type PauseRunOptions,
  type RunControlResult,
  type RunStatusSnapshot,
} from '../executor/index.js';
import {
  createTaskScheduler,
  type SchedulerOptions,
  type ScheduleResult,
} from '../scheduler/index.js';
import {
  createResourceManager,
  createResourceWaitQueue,
  type Resource,
  type ResourcePoolOptions,
} from '../resource/index.js';
import type { WorkflowObserver } from '../observer/index.js';
import { WorkflowEventTypes } from '../observer/event-types.js';
import { ResourceRegistrationError } from '../errors.js';

export interface EngineOptions {
  plugins?: PluginDefinition[];
  maxParallelSteps?: number;
  failFast?: boolean;
  /** 传给 createTaskScheduler；scheduleWorkflow 提交的任务自带 retryable: false */
  scheduler?: SchedulerOptions;
  /** 传给 createResourceManager；引擎强制 autoCleanup: false 以复用槽位 */
  resources?: ResourcePoolOptions;
  /** 引擎启动时预注册的资源（步骤声明 resourceType 前须确保池中有对应类型） */
  initialResources?: Resource[];
  /** default 资源池固定槽位数（未写 resourceType 的步骤使用） */
  defaultPoolSize?: number;
  observer?: WorkflowObserver;
  /** hard cancel / pause+abortInFlight 时 in-flight 步骤超时（ms），透传 executor */
  inFlightTimeoutMs?: number;
}

/** 资源等待队列项与 releaseHandles 的键：${workflowRunId}:${stepId} */
function stepResourceKey(workflowRunId: string, stepId: string): string {
  return `${workflowRunId}:${stepId}`;
}

const DEFAULT_RESOURCE_TYPE = 'default';

/**
 * 解析步骤所需资源类型。config.resourceType 未声明或为空时使用 default 池。
 * 拼写错误不会抛错，会静默落到 default（见 CE-010）。
 */
function getResourceType(step: WorkflowStep): string {
  const resourceType = step.config.resourceType;
  if (typeof resourceType === 'string' && resourceType.length > 0) {
    return resourceType;
  }
  return DEFAULT_RESOURCE_TYPE;
}

/**
 * 创建引擎实例（长生命周期，由 apps/server 等持有至 destroy）。
 *
 * 接线顺序：resourceManager ← resourceWaitQueue ← executor 钩子；
 * scheduler 与 executor 通过 runWorkflow 间接协作。
 */
export function createEngine(options: EngineOptions = {}) {
  const plugins = createPluginManager();
  const scheduler = createTaskScheduler(options.scheduler);
  const maxResources = options.resources?.maxResources ?? 10;

  // 延迟绑定：resourceManager 构造时需要 onResourceAvailable，但 waitQueue 尚未创建
  const waitQueueHolder: { notify?: (type: string) => void } = {};
  const resources = createResourceManager({
    autoCleanup: false,
    ...options.resources,
    onResourceAvailable: (type) => waitQueueHolder.notify?.(type),
  });
  const resourceWaitQueue = createResourceWaitQueue({ resourceManager: resources });
  waitQueueHolder.notify = (type) => resourceWaitQueue.notifyResourceAvailable(type);

  function assertResourceRegistered(resource: Resource): void {
    if (!resources.registerResource(resource)) {
      throw new ResourceRegistrationError(
        `资源池已满（上限 ${maxResources}），无法注册 ${resource.id}`,
      );
    }
  }

  // 预注册 default 池，供未声明 resourceType 的步骤使用
  const defaultPoolSize = options.defaultPoolSize ?? 5;
  for (let i = 0; i < defaultPoolSize; i++) {
    assertResourceRegistered({
      id: `${DEFAULT_RESOURCE_TYPE}-${i}`,
      type: DEFAULT_RESOURCE_TYPE,
      name: `${DEFAULT_RESOURCE_TYPE}-slot-${i}`,
      status: 'available',
    });
  }

  if (options.initialResources) {
    for (const resource of options.initialResources) {
      assertResourceRegistered(resource);
    }
  }

  /** 步骤已 acquire 的 release 回调；键为 stepResourceKey */
  const releaseHandles = new Map<string, () => void>();

  const executor = createWorkflowExecutor({
    maxParallelSteps: options.maxParallelSteps ?? 1,
    failFast: options.failFast ?? true,
    inFlightTimeoutMs: options.inFlightTimeoutMs,
    observer: options.observer,
    pluginExecutor: (name, config, ctx) => plugins.executePlugin(name, config, ctx),
    resolvePluginResultSchema: (name) => plugins.getPlugin(name)?.resultSchema,
    // 资源钩子：在 step:start 之前挂起等待槽位（可能触发 step:queued）
    onStepStart: async (step, context, meta) => {
      const resourceType = getResourceType(step);
      // runId 由 executor 从 workflowRunId 注入；缺失时跳过资源分配（单测/无 meta 场景）
      const runId =
        typeof context.runId === 'string' && context.runId.length > 0 ? context.runId : '';
      if (!runId) return;

      const priority = step.priority ?? context.priority ?? 0;
      const id = stepResourceKey(runId, step.id);
      const { release } = await resourceWaitQueue.acquire({
        id,
        workflowRunId: runId,
        resourceType,
        priority,
        // 进入资源堆时通知观察者（即使随后立即可用也会触发，见 CE-008）
        onQueued: meta
          ? () =>
              options.observer?.onEvent?.({
                type: WorkflowEventTypes.STEP_QUEUED,
                workflowRunId: runId,
                meta,
                step,
                resourceType,
                priority,
              })
          : undefined,
      });
      releaseHandles.set(id, release);
    },
    // 步骤结束归还资源；in-flight 超时时 executor 传入 deferReleaseUntil 推迟释放
    onStepComplete: (step, _result, context, completeOptions) => {
      const runId = typeof context.runId === 'string' ? context.runId : '';
      if (!runId) return;

      const key = stepResourceKey(runId, step.id);
      const release = releaseHandles.get(key);
      if (!release) return;

      if (completeOptions?.deferReleaseUntil) {
        void completeOptions.deferReleaseUntil.finally(() => {
          const deferredRelease = releaseHandles.get(key);
          if (deferredRelease) {
            deferredRelease();
            releaseHandles.delete(key);
          }
        });
        return;
      }

      release();
      releaseHandles.delete(key);
    },
    // 失败步骤立即释放（无 defer 路径）
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
    // failFast 中止 / 用户取消：取消同 run 下仍在资源队列中的步骤
    onWorkflowAbort: (workflowRunId) => {
      resourceWaitQueue.cancelByWorkflowRunId(workflowRunId);
    },
  });

  if (options.plugins) {
    plugins.registerPlugins(options.plugins);
  }

  /** 同步执行工作流，直接 await 至整次 Run 结束 */
  async function runWorkflow(
    workflowRunId: string,
    workflow: WorkflowDefinition,
    context: Partial<ExecutionContext> = {},
  ): Promise<WorkflowRunResult> {
    return executor.executeWorkflow(workflowRunId, workflow, context);
  }

  /**
   * 将整次 workflow 作为调度器任务异步投递。
   * retryable: false — 业务失败不 throw，且整次重跑非幂等，禁止任务级重试。
   */
  function scheduleWorkflow(
    workflowRunId: string,
    workflow: WorkflowDefinition,
    context: Partial<ExecutionContext> = {},
  ): Promise<ScheduleResult> {
    assertValidWorkflowRunId(workflowRunId);
    const taskId = `workflow-${workflow.id}-${Date.now()}`;
    return scheduler.scheduleTask({
      id: taskId,
      name: workflow.name,
      priority: 0,
      createdAt: new Date(),
      workflowRunId,
      retryable: false,
      execute: () => runWorkflow(workflowRunId, workflow, context),
    });
  }

  /**
   * 取消 Run：先撤销调度队列中尚未进入 executor 的任务，再 cancel executor 侧活跃 Run。
   */
  async function cancelRun(
    workflowRunId: string,
    cancelOptions?: CancelRunOptions,
  ): Promise<RunControlResult> {
    scheduler.cancelScheduledTaskByWorkflowRunId(workflowRunId);
    return executor.cancelRun(workflowRunId, cancelOptions);
  }

  /** 暂停 / 恢复 Run，透传 executor（含 waitInFlight、abortInFlight 语义） */
  function pauseRun(
    workflowRunId: string,
    pauseOptions?: PauseRunOptions,
  ): Promise<RunControlResult> {
    return executor.pauseRun(workflowRunId, pauseOptions);
  }

  /** 从 paused 恢复为 running */
  function resumeRun(workflowRunId: string): Promise<RunControlResult> {
    return executor.resumeRun(workflowRunId);
  }

  function getRunStatus(workflowRunId: string): RunStatusSnapshot | undefined {
    return executor.getRunStatus(workflowRunId);
  }

  function cancelScheduledTask(taskId: string): boolean {
    return scheduler.cancelScheduledTask(taskId);
  }

  function getScheduledTaskId(workflowRunId: string): string | undefined {
    return scheduler.getTaskIdByWorkflowRunId(workflowRunId);
  }

  /**
   * 销毁引擎：取消所有活跃 Run，释放资源等待队列/池与执行历史。
   * 不自动 unregister 插件，调用方若需清空插件表应自行处理。
   */
  async function destroy(): Promise<void> {
    await executor.destroyActiveRuns();
    resourceWaitQueue.destroy();
    resources.destroy();
    executor.clearHistory();
    releaseHandles.clear();
  }

  return {
    runWorkflow,
    scheduleWorkflow,
    cancelRun,
    pauseRun,
    resumeRun,
    getRunStatus,
    cancelScheduledTask,
    getScheduledTaskId,
    // 插件注册表（透传 plugin manager）
    registerPlugin: plugins.registerPlugin,
    registerPlugins: plugins.registerPlugins,
    unregisterPlugin: plugins.unregisterPlugin,
    getPlugin: plugins.getPlugin,
    getPlugins: plugins.getAllPlugins,
    getPluginNames: plugins.getPluginNames,
    hasPlugin: plugins.hasPlugin,
    // 高级用法：直接访问子模块（定制编排、测试、监控队列状态）
    getResourceManager: () => resources,
    registerResource: assertResourceRegistered,
    getResourceWaitQueue: () => resourceWaitQueue,
    getScheduler: () => scheduler,
    getExecutor: () => executor,
    destroy,
  };
}
