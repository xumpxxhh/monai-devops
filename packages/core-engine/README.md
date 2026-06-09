# core-engine

monai-devops 工作流编排内核。负责 DAG 执行、任务调度、插件注册与资源池管理；插件契约由 [`plugin-sdk`](../plugin-sdk) 定义，本包只依赖 SDK、不反向耦合。

## 架构

```mermaid
flowchart TB
  subgraph entry [engine]
    CE[createEngine]
  end
  subgraph modules [modules]
    PM[plugin]
    EX[executor]
    SCH[scheduler]
    RS[resource-scheduler]
    RES[resource]
  end
  SDK[plugin-sdk]
  CE --> PM
  CE --> EX
  CE --> SCH
  CE --> RS
  CE --> RES
  PM --> SDK
  EX -->|"pluginExecutor"| PM
  EX -->|"onStepStart acquire"| RS
  RS --> RES
  SCH -->|"scheduleWorkflow"| EX
```

推荐通过 **`createEngine`** 使用默认接线；各子模块也可单独创建，用于定制编排或测试。

## 与 plugin-sdk 的分工

| 类型                                       | 所在包      | 含义                                                                     |
| ------------------------------------------ | ----------- | ------------------------------------------------------------------------ |
| `PluginManifest`                           | plugin-sdk  | 插件注册元数据（name / version）                                         |
| `PluginConfig`                             | plugin-sdk  | 单次 `execute` 入参                                                      |
| `PluginContext`                            | plugin-sdk  | 单次执行上下文（索引签名，无编排字段）                                   |
| `PluginResult`                             | plugin-sdk  | 执行结果（含可选 `code`）                                                |
| `PluginFailureCode` / `PluginFailureCodes` | plugin-sdk  | 插件失败错误码常量                                                       |
| `ExecutionContext`                         | core-engine | 编排器注入的上下文（含 workflow / step / 前序结果等）                    |
| `WorkflowContextKeys`                      | core-engine | 注入字段名常量，供 `getContext` 读取                                     |
| `StepStatus` / `StepStatuses`              | core-engine | 步骤状态：`completed` / `skipped` / `failed`                             |
| `StepFailureKind` / `StepFailureKinds`     | core-engine | 失败分类：`plugin` / `resource` / `internal`                             |
| `SkipReason` / `SkipReasons`               | core-engine | 跳过原因：`condition_not_met` / `dependency_failed` / `workflow_aborted` |

依赖方向：**core-engine → plugin-sdk**。插件实现只需依赖 SDK；若需读取 `stepId`、`previousResults` 等，使用 `getContext(ctx, WorkflowContextKeys.xxx)`，字段由 executor 在运行时写入。

## 错误模型

各层失败表达方式统一如下：

| 层级       | 失败表达方式                                                             | 示例                               |
| ---------- | ------------------------------------------------------------------------ | ---------------------------------- |
| 插件边界   | `PluginResult { success: false, code?, message? }`                       | 业务失败、插件未找到、execute 异常 |
| 步骤编排   | `ExecutionResult { status: failed, failureKind, error?, pluginResult? }` | 插件失败、资源分配失败             |
| 步骤跳过   | `ExecutionResult { status: skipped, skipReason }`                        | 条件不满足、依赖失败               |
| 工作流校验 | `throw WorkflowValidationError`                                          | 环依赖、无效 dependsOn（启动前）   |
| 调度器     | `ScheduleResult { success: false, error }`                               | 整次 workflow 任务重试耗尽         |

**原则**：插件层永不 throw；基础设施钩子（如资源分配）可 throw `StepExecutionError`，由 executor 统一捕获并转为 `StepStatuses.FAILED`。

**常量（推荐用法，避免硬编码字符串）**

| 常量                 | 所在包      | 键                                           |
| -------------------- | ----------- | -------------------------------------------- |
| `PluginFailureCodes` | plugin-sdk  | `PLUGIN_NOT_FOUND`、`PLUGIN_EXECUTION_ERROR` |
| `StepStatuses`       | core-engine | `COMPLETED`、`SKIPPED`、`FAILED`             |
| `StepFailureKinds`   | core-engine | `PLUGIN`、`RESOURCE`、`INTERNAL`             |
| `SkipReasons`        | core-engine | `CONDITION_NOT_MET`、`DEPENDENCY_FAILED`     |

```ts
import { PluginFailureCodes } from 'plugin-sdk';
import { StepStatuses, StepFailureKinds, SkipReasons } from 'core-engine';

// 判断步骤结果
const step = run.results[0];
if (step.status === StepStatuses.FAILED) {
  console.log(step.failureKind); // StepFailureKinds.PLUGIN 等
} else if (step.status === StepStatuses.SKIPPED) {
  console.log(step.skipReason); // SkipReasons.CONDITION_NOT_MET 等
}

// 插件失败码
if (step.pluginResult?.code === PluginFailureCodes.PLUGIN_NOT_FOUND) {
  /* ... */
}
```

**ExecutionResult 字段**

| 字段           | 说明                                                                                 |
| -------------- | ------------------------------------------------------------------------------------ |
| `status`       | `StepStatuses.COMPLETED` \| `SKIPPED` \| `FAILED`                                    |
| `success`      | 与 status 同步：`status !== StepStatuses.FAILED`                                     |
| `failureKind`  | 失败时：`StepFailureKinds.PLUGIN` \| `RESOURCE` \| `INTERNAL`                        |
| `skipReason`   | 跳过时：`SkipReasons.CONDITION_NOT_MET` \| `DEPENDENCY_FAILED` \| `WORKFLOW_ABORTED` |
| `pluginResult` | 插件返回的原始结果                                                                   |
| `error`        | 失败时的 Error 对象                                                                  |
| `result`       | 成功时为插件 data；跳过时保留 `{ skipped: true, reason }` 以兼容旧断言               |

**PluginFailureCodes**（plugin-sdk，`success: false` 时由 plugin 模块自动填充）

- `PLUGIN_NOT_FOUND` — 插件未注册
- `PLUGIN_EXECUTION_ERROR` — execute 抛出未捕获异常

## 模块说明

### engine（门面）

`createEngine(options?)` 创建引擎实例，串联 plugin、executor、scheduler、resource。

**EngineOptions**

| 选项               | 默认   | 说明                                 |
| ------------------ | ------ | ------------------------------------ |
| `plugins`          | —      | 初始注册的 `PluginDefinition[]`      |
| `maxParallelSteps` | `1`    | 工作流步骤最大并行数                 |
| `failFast`         | `true` | 任一步失败后是否停止调度后续步骤     |
| `scheduler`        | —      | 传给 `createTaskScheduler` 的选项    |
| `resources`        | —      | 传给 `createResourceManager` 的选项  |
| `observer`         | —      | 工作流生命周期观察者，见「可观测性」 |

**主要 API**

- `runWorkflow(workflow, context?)` → `WorkflowRunResult`
- `scheduleWorkflow(workflow, context?)` → `Promise<ScheduleResult>`（整次 workflow 作为调度任务）
- `registerPlugin` / `registerPlugins` / `getPlugins` 等（委托 plugin 模块）
- `getExecutor()` / `getScheduler()` / `getResourceManager()` / `getResourceScheduler()` — 高级用法
- `destroy()` — 释放资源池定时器

### executor（DAG 工作流）

基于 `dependsOn` 构建有向图，启动前做 **环检测**（Kahn），非法图抛出 `WorkflowValidationError`。

- **并行**：就绪步骤在 `maxParallelSteps` 限制下并行执行
- **failFast: true**（默认）：已有步骤失败后，不再调度未开始步骤；进行中的步骤会跑完
- **failFast: false**：依赖失败的下游标记为 `status: StepStatuses.SKIPPED`、`skipReason: SkipReasons.DEPENDENCY_FAILED`
- **条件**：结构化 `StepCondition`（`when` / `equals` / `exists`），不满足则 `status: StepStatuses.SKIPPED`、`skipReason: SkipReasons.CONDITION_NOT_MET`
- **failFast 中止**：仍在就绪队列但尚未开始的步骤补发 `step:finished`，`skipReason: SkipReasons.WORKFLOW_ABORTED`；因依赖失败而跳过的下游仍为 `DEPENDENCY_FAILED`
- **钩子**：`onStepStart` / `onStepComplete` / `onStepError`（engine 内用于资源分配；高级定制用）
- **观察者**：`observer.onEvent` 接收结构化生命周期事件（推荐调用层使用）

也可单独使用 `createWorkflowExecutor(options)`，自行注入 `pluginExecutor` 与 `observer`。

## 可观测性

执行过程中通过 **`WorkflowObserver`** 向调用层暴露结构化事件；engine **不包含**持久化、HTTP 或追踪 SDK，由 server/CLI 在 `onEvent` 中自行落库、打日志、接 OpenTelemetry。

### WorkflowObserver

```ts
import {
  createEngine,
  type WorkflowLifecycleEvent,
  type WorkflowObserver,
} from "core-engine";

const observer: WorkflowObserver = {
  onEvent: async (event: WorkflowLifecycleEvent) => {
    switch (event.type) {
      case "workflow:start":
        // 记录 run 开始
        break;
      case "step:queued":
        // 步骤进入资源等待队列
        break;
      case "step:start":
        // 资源分配成功，即将执行插件
        break;
      case "step:finished":
        // 步骤结束（含 completed / skipped / failed）
        break;
      case "workflow:finished":
        // 整次 run 结束
        break;
    }
  },
};

const engine = createEngine({ plugins: [...], observer });

await engine.runWorkflow(workflow, {
  runId: "550e8400-e29b-41d4-a716-446655440000",
  traceId: "trace-from-request",
});
```

### 事件类型

| 事件                | 触发时机                                                                |
| ------------------- | ----------------------------------------------------------------------- |
| `workflow:start`    | DAG 校验通过后、任一步骤开始前                                          |
| `step:queued`       | 步骤进入资源调度队列（条件跳过**不**触发）                              |
| `step:start`        | 资源分配成功后、插件执行前（条件跳过**不**触发）                        |
| `step:finished`     | 步骤结束（成功、失败、跳过均触发；失败只发此事件，不发单独 error 事件） |
| `workflow:finished` | 所有步骤处理完毕（含 failFast 补发的未执行步）                          |

每条事件携带 **`WorkflowRunMeta`**：`runId`、`workflowId`、可选 `traceId`、原始 `context`。

- **`runId`**：调用方可在 `runWorkflow` 的 context 中传入；未传时 executor 自动生成 UUID，并注入到每步 `ExecutionContext`（键名见 `WorkflowContextKeys.runId`）。
- **`traceId`**：同上，键名 `WorkflowContextKeys.traceId`；供调用层日志/追踪关联，engine 不接入 OTel。

### 语义说明

- **并行步骤**：`step:finished` 顺序不保证，调用方按 `stepId` / `runId` 聚合。
- **DAG 非法**：抛出 `WorkflowValidationError`，**不**发 `workflow:start`。
- **failFast**：仍在就绪队列但尚未开始的步骤会补发 `step:finished`（`skipReason: WORKFLOW_ABORTED`）；因依赖失败跳过的下游为 `DEPENDENCY_FAILED`。均写入最终 `result.results`。
- **单独 `executeStep`**：无 `workflow:start` / `workflow:finished`，仅在有 `observer` 时发步骤事件（需传入 workflow 级 meta 的场景请用 `executeWorkflow`）。

### ExecutorOptions.observer

直接使用 `createWorkflowExecutor({ observer })` 时行为与经 `createEngine` 透传一致。`onStepStart` / `onStepComplete` / `onStepError` 保留给引擎内部（资源分配）或高级定制，对外推荐 `observer`。

### scheduler（任务队列 + 小顶堆）

待执行任务保存在 **小顶堆** [`utils/min-heap.ts`](./utils/min-heap.ts)（包入口不导出，仅供 scheduler 内部使用）。

| 操作        | 复杂度   |
| ----------- | -------- |
| 入队 `push` | O(log n) |
| 出队 `pop`  | O(log n) |

**优先级规则（务必注意）**

- `priority` **数值越小，越先执行**（`0` 先于 `10`），与「数值越大越优先」的系统相反
- 同 `priority` 时，按 `createdAt` **先入先出**

**SchedulerOptions**

| 选项             | 默认   | 说明             |
| ---------------- | ------ | ---------------- |
| `maxConcurrency` | `5`    | 同时运行的任务数 |
| `retryAttempts`  | `3`    | 失败重试次数     |
| `retryDelay`     | `1000` | 重试间隔（ms）   |

`scheduleTask(task)` 返回 `Promise<ScheduleResult>`，任务完成后 resolve；`getQueueStatus()` 返回 `queueLength`、`runningTasks`、`maxConcurrency`。

### plugin（插件注册表）

`createPluginManager()` 提供注册、卸载、`executePlugin(name, config, context)`。未找到插件或执行异常时返回带 `PluginFailureCodes` 的 `{ success: false, message }`（不抛错）；engine 透传 Result，executor 将其转为 `ExecutionResult.status: StepStatuses.FAILED`。

### resource-scheduler（Step 级资源调度队列）

`createResourceStepScheduler` 按 **resourceType** 维护独立小顶堆队列，最小调度单元为单个 workflow 的单个 step（队列项 ID：`${runId}:${stepId}`）。

- **资源不足**：步骤挂起等待，**不**立即失败；`maxParallelSteps` 等待期间仍占用 inFlight 槽位
- **排序**：`priority` 数值越小越优先；同 priority 按入队时间 FIFO
- **优先级来源**：`step.priority ?? context.priority ?? 0`
- **failFast**：`cancelByRunId` 取消同 run 下排队步骤，转为 `SKIPPED / WORKFLOW_ABORTED`
- **唤醒**：`releaseResource` 或 `registerResource` 触发 `onResourceAvailable` 回调后重新 `processQueue`

### resource（资源池）

`createResourceManager` 管理 `available` / `allocated` / `released` 状态。

- 步骤 `config.resourceType` 为字符串时，engine 经 resource-scheduler `acquire` 分配、`onStepComplete` / `onStepError` 释放
- `autoCleanup: false`（默认测试配置）时 `release` 将资源归还为 `available` 供复用
- `autoCleanup: true` 时构造即启动定时清理；`release` 后延迟 `cleanupInterval` 从 Map 删除
- 分配/释放对同一 id 使用互斥，避免并发竞态

## 快速开始

```ts
import { createEngine, WorkflowContextKeys } from 'core-engine';
import { createPlugin, getContext } from 'plugin-sdk';

const echoPlugin = createPlugin({
  name: 'echo',
  version: '1.0.0',
  execute: async (config, ctx) => {
    const stepId = getContext<string>(ctx, WorkflowContextKeys.stepId);
    return { success: true, data: { stepId, value: config.value } };
  },
});

const engine = createEngine({
  plugins: [echoPlugin],
  maxParallelSteps: 2,
  failFast: true,
});

const run = await engine.runWorkflow({
  id: 'demo',
  name: 'Demo Pipeline',
  steps: [
    { id: 'a', name: 'A', plugin: 'echo', config: { value: 1 } },
    { id: 'b', name: 'B', plugin: 'echo', config: { value: 2 } },
    {
      id: 'c',
      name: 'C',
      plugin: 'echo',
      config: { value: 3 },
      dependsOn: ['a', 'b'],
    },
  ],
});

console.log(run.success, run.results[0]?.status);
engine.destroy();
```

异步投递到调度器：

```ts
const scheduled = await engine.scheduleWorkflow({
  id: 'demo-async',
  name: 'Async',
  steps: [{ id: 's1', name: 'S1', plugin: 'echo', config: {} }],
});
// scheduled.result 为 WorkflowRunResult（scheduleTask 的 result 字段）
```

## 工作流定义要点

**WorkflowDefinition**

- `id` / `name`：工作流标识与展示名
- `steps`：`WorkflowStep[]`

**WorkflowStep**

| 字段        | 说明                                                       |
| ----------- | ---------------------------------------------------------- |
| `id`        | 步骤唯一 ID                                                |
| `name`      | 展示名                                                     |
| `plugin`    | 已注册插件名                                               |
| `config`    | `PluginConfig`，步骤入参                                   |
| `dependsOn` | 依赖的步骤 ID 列表                                         |
| `condition` | 可选，`{ when, equals?, exists? }`，`when` 指向前序步骤 ID |

**config 约定**

- `resourceType?: string` — 需要资源池时声明类型，由 engine 自动分配/释放

## 包导出

入口 [`index.ts`](./index.ts) 导出：

- `./executor` — `createWorkflowExecutor`、`WorkflowDefinition`、`ExecutionContext` 等
- `./scheduler` — `createTaskScheduler`
- `./plugin` — `createPluginManager`
- `./resource` — `createResourceManager`
- `./resource-scheduler` — `createResourceStepScheduler`
- `./engine` — `createEngine`
- `./observer` — `WorkflowObserver`、`WorkflowLifecycleEvent`、`WorkflowRunMeta`
- `./context-keys` — `WorkflowContextKeys`
- `./errors` — `StepExecutionError`、`WorkflowValidationError`、`StepStatuses`、`StepFailureKinds`、`SkipReasons` 及对应类型

## 开发与测试

```bash
# 类型检查
pnpm --filter core-engine check-types

# 单元测试（递归 __tests__，见 scripts/run-tests.mjs）
pnpm --filter core-engine test
```

测试覆盖：DAG 并行与 failFast、engine 集成、错误模型、scheduler（含优先级与并发）、min-heap、resource 生命周期。

## 子模块独立使用

不必经过 `createEngine`，可按需组合：

```ts
import { createWorkflowExecutor } from 'core-engine/executor';
import { createTaskScheduler } from 'core-engine/scheduler';
import { createPluginManager } from 'core-engine/plugin';
```

（实际 import 路径以 monorepo 内 `core-engine` 包名为准。）

## 后续规划

- Nest `apps/server` 集成与 HTTP API（消费 `WorkflowObserver`）
- 表达式级 `condition`（当前仅为结构化条件）
- 步骤级 `AbortSignal` 取消进行中的插件执行
