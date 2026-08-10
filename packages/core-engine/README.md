# @monai-devops/core-engine

工作流编排核心库：在内存中按 DAG 调度步骤、执行插件、管理资源槽位，并提供取消 / 暂停 / 恢复与生命周期事件。

推荐入口是 `createEngine`；它按默认拓扑把 plugin、executor、scheduler、resource 接好。高级场景也可单独使用各子模块。

## 定位与边界

| 层 | 职责 |
|---|---|
| **engine** | 门面：资源 acquire/release 钩子、workflow 级入队、`cancelRun` 联动调度器 |
| **executor** | DAG 校验与并行调度、步骤执行、Run 生命周期、观察者事件 |
| **plugin** | 插件注册表与执行包装（捕获 throw → `PluginResult`） |
| **scheduler** | 整次 workflow 任务的优先级队列与并发上限 |
| **resource** | 资源池 + 步骤级等待队列（按 `resourceType` 抢槽位） |
| **observer** | 生命周期事件类型与 `WorkflowObserver` 契约 |

依赖 `@monai-devops/plugin-sdk` 的插件契约（`PluginDefinition` / `PluginResult` / `PluginContext`）。插件 `execute` 约定不向外抛业务失败；引擎侧再包一层，把意外 throw 与取消信号统一成结果。

## 安装与环境

- Node.js `>= 20`
- 包类型：ESM（`"type": "module"`）
- 从工作区引用：`@monai-devops/core-engine`

```bash
pnpm --filter @monai-devops/core-engine build
pnpm --filter @monai-devops/core-engine test
```

## 快速开始

```ts
import { createEngine } from '@monai-devops/core-engine';
import { createPlugin } from '@monai-devops/plugin-sdk';

const echo = createPlugin({
  name: 'echo',
  version: '1.0.0',
  execute: async (config) => ({
    success: true,
    data: { message: String(config.message ?? '') },
  }),
});

const engine = createEngine({
  plugins: [echo],
  maxParallelSteps: 2,
  failFast: true,
  observer: {
    onEvent(event) {
      console.log(event.type, event.workflowRunId);
    },
  },
});

const result = await engine.runWorkflow('run-001', {
  id: 'wf-hello',
  name: 'hello',
  steps: [
    {
      id: 'greet',
      name: 'Greet',
      plugin: 'echo',
      config: { message: 'hi' },
    },
  ],
});

console.log(result.status, result.results);
await engine.destroy();
```

异步投递（经调度器，不阻塞调用方立即拿到「任务已入队」的 Promise）：

```ts
const scheduled = await engine.scheduleWorkflow('run-002', workflow);
// scheduled: { taskId, success, result?, error?, cancelled? }
```

## 架构一览

```
createEngine
├── PluginManager          注册 / 执行插件
├── TaskScheduler          scheduleWorkflow → 整次 Run 入队
├── ResourceManager        按 type 管理槽位
├── ResourceWaitQueue      步骤抢槽；无空闲则挂起
└── WorkflowExecutor       DAG 主循环 + cancel/pause/resume
        │
        ├─ onStepStart     → waitQueue.acquire（set_state 不占槽）
        ├─ onStepComplete  → release
        ├─ onStepError     → release
        └─ onWorkflowAbort → cancelByWorkflowRunId
```

调用方日常只用 engine 返回的 API；`getExecutor` / `getScheduler` / `getResourceManager` / `getResourceWaitQueue` 供测试与定制。

---

## 工作流定义

```ts
interface WorkflowDefinition {
  id: string;
  name: string;
  steps: WorkflowStep[];
  /** 可选。持久化为 JSON Schema；声明后才有 run state */
  stateSchema?: JsonSchemaObject;
}
```

### 步骤形态（`kind`）

未写 `kind` 时按 **plugin** 处理。

#### 1. `plugin`（默认）

```ts
{
  id: 'build',
  name: 'Build',
  plugin: 'shell',
  config: { cmd: 'pnpm build', resourceType: 'runner' },
  dependsOn?: string[];
  condition?: StepCondition;
  priority?: number; // 越小越优先；默认继承 run 级 priority
}
```

`config.resourceType` 决定占用哪类资源池；未声明或空字符串则用引擎预置的 `default` 池。拼写错误的类型不会抛错，会落到对应类型的等待（池中无槽则一直排队，直到注册资源或取消）。

#### 2. `set_state`

浅合并 `patch` 到当前 run state，并用 `stateSchema` 校验。不占用资源池。

```ts
{
  id: 'init',
  name: 'Init',
  kind: 'set_state',
  patch: { count: 1 },
}
```

要求工作流已声明 `stateSchema`，否则启动前 `WorkflowValidationError`。

#### 3. `workflow`（引用子工作流）

通过 `importId` 解析子定义（由调用方注入 `resolveWorkflow`）。可单次执行，也可配置 `loop`。

```ts
{
  id: 'child',
  name: 'Child',
  kind: 'workflow',
  workflowRef: { importId: 'import-xxx' },
  inputState?: { /* 可含 $ref */ },
  loop?: {
    maxIterations: 10,
    until?: { when: 'done', equals: true }, // 基于子 run 的 state_out
  },
}
```

约束（静态 + 运行时）：

- 嵌套深度默认上限 `maxNestingDepth = 3`
- 禁止引用环（祖先 `workflowId` 链）
- 禁止「循环嵌套循环」（带 `loop` 的引用之下，子图不得再含带 `loop` 的 workflow 步骤）
- `inputState` / `loop.until` 要求被引用方声明了 `stateSchema`
- 子 run id：`deriveChildRunId(parentRunId, stepId, iteration)`（可读前缀 + 短哈希）

可用 `validateWorkflowNesting(workflow, { resolveWorkflow, maxNestingDepth })` 在保存期提前校验。

### 依赖与条件

- `dependsOn`：DAG 边。启动前 `validateDag`（Kahn）校验无环、无悬空依赖、无重复 id。
- `condition`：基于 `previousResults`（上游步骤的 `result`；**FAILED 上游不写入**）求值。

```ts
interface StepCondition {
  when: string;      // previousResults 的 key（通常是上游 stepId）
  equals?: unknown;  // 严格相等
  exists?: boolean;  // true=存在且非 null；false=不存在或 null
  // 未写 equals/exists 时：值非 null/undefined 即通过
}
```

依赖链上有 FAILED 时，下游标记 `SKIPPED` + `dependency_failed`，并递归传播。

### 并行与 failFast

- `maxParallelSteps`：同时 in-flight 的步骤上限（engine 默认 `1`）
- `failFast`（默认 `true`）：任一步 FAILED 后停止调度新步骤，取消同 run 仍在资源队列中的等待；未执行步骤补发 `workflow_aborted` 跳过。`false` 时尽量跑完可调度步骤，收尾时未调度的标 `dependency_failed`。

---

## Context 引用（`$ref`）

在 plugin `config`、`set_state.patch`、`workflow.inputState` 中可嵌入：

```ts
{
  $ref: {
    fromStepId: 'upstream-step', // 或 '__workflow_state__'
    path: ['data', 'url'],       // 逐段下钻；数组段须为整数下标
  }
}
```

规则：

| 规则 | 说明 |
|---|---|
| 祖先约束 | `fromStepId` 必须是当前步骤在 `dependsOn` 上的祖先（直接或间接） |
| 可注入数据 | 仅 `COMPLETED` 且 `pluginResult.success` 且 `data !== undefined` 的上游 |
| state 引用 | `fromStepId === '__workflow_state__'`（常量 `WORKFLOW_STATE_REF_ID`），要求已声明 `stateSchema` |
| 启动前校验 | `validateWorkflowContextReferences`；有 `resultSchema` 时还会检查来源是否允许被引用 |
| 运行时失败 | 抛 `StepExecutionError`，`failureKind: config_resolution` |

解析后整字段替换为上游值；`null` 是合法叶子值。

---

## Run State

- 仅当 `workflow.stateSchema` 存在时启用；结束时 `WorkflowRunResult.state` 带回最终快照。
- `initialState`（`ExecuteWorkflowCallOptions`）或 schema `default` 作为初值；须通过 schema 校验。
- `set_state`：解析 patch 中的 `$ref` → 浅合并 → 再 `parseState`。
- JSON Schema → Zod 覆盖常见子集：`object` / `string` / `number` / `integer` / `boolean` / `array` / `null`、`properties`、`required`、`enum`、`default`、`additionalProperties`。不支持 `$ref`、`anyOf`/`oneOf`/`allOf`、联合 `type` 数组等；转换失败为 `StateSchemaConversionError`。

---

## 资源模型

两层调度，不要混淆：

| 模块 | 调度对象 |
|---|---|
| **scheduler** | 整次 `scheduleWorkflow` 任务 |
| **resource wait queue** | 单个步骤对物理槽位的 `acquire` |

引擎启动时预注册 `defaultPoolSize`（默认 5）个 `type: 'default'` 槽位；可用 `initialResources` / `registerResource` 追加类型。池满抛 `ResourceRegistrationError`。引擎强制 `autoCleanup: false`，释放后槽位回到 `available` 并唤醒同 type 等待者。

等待规则（每个 `resourceType` 独立小顶堆）：

- `priority` 越小越优先（`step.priority ?? context.priority ?? 0`）
- 同优先级按入队时间 FIFO
- 取消为惰性删除：标记 `cancelled`，浮到堆顶再 `reject(ResourceQueueCancelledError)`
- 入队后会先走 `onQueued`（发出 `step:queued`），再尝试分配——即使立刻有空闲槽也会先排队事件

`set_state` 不走资源池。

---

## Run 控制

同一 `workflowRunId` 同时只能有一个活跃 Run（否则 `RunAlreadyActiveError`）。

### `workflowRunId` 校验

- 非空字符串，无首尾空白
- 仅 `[A-Za-z0-9_-]`，长度 ≤ 128
- 非法时抛 `WorkflowRunIdValidationError`，**不**发 `workflow:start`

### 取消 `cancelRun(id, { mode? })`

| mode | 行为 |
|---|---|
| `best-effort`（默认） | 停止调度新步骤；已在跑的步骤继续，直至自行结束 |
| `hard` | 对 in-flight 步骤 `AbortSignal.abort`；超时（默认 `inFlightTimeoutMs = 30000`）后步骤按跳过收尾，资源释放可推迟到插件真正 settle |

engine 的 `cancelRun` 会先撤销调度器中尚未开始的同 `workflowRunId` 任务。

### 暂停 / 恢复

```ts
await engine.pauseRun(id, {
  waitInFlight?: boolean;  // 默认 true：等 in-flight 结束后再 paused
  abortInFlight?: boolean; // true 时向 in-flight 注入 abort（并隐含 waitInFlight）
});
await engine.resumeRun(id);
```

嵌套 workflow 步骤会把 pause / resume / cancel 级联到活跃子 run；子 run 已 paused 时父 run 可进入 `paused`（不因该嵌套步骤仍 in-flight 而卡住）。

### 状态快照

```ts
engine.getRunStatus(id);
// { workflowRunId, status, inFlightSteps, progress? }
// status: running | pausing | paused | cancelling | cancelled | finished | failed | unknown
```

### 整次 Run 结果

```ts
interface WorkflowRunResult {
  success: boolean;
  status: 'success' | 'failed' | 'cancelled';
  workflowId: string;
  results: ExecutionResult[];
  state?: unknown;
}
```

`cancelled` 仅当中止原因为用户取消或 `destroy`；`failFast` 中止仍汇总为 `failed` / `success`。

### 步骤结果

| `status` | 含义 |
|---|---|
| `completed` | 成功（含成功的跳过语义之外的正常完成） |
| `skipped` | 条件不满足 / 依赖失败 / 工作流中止 / 用户取消 / 暂停中断 |
| `failed` | 插件失败、配置解析失败、子工作流失败、内部错误等 |

`skipReason`：`condition_not_met` | `dependency_failed` | `workflow_aborted` | `user_cancelled` | `pause_interrupted`

`failureKind`：`plugin` | `resource` | `internal` | `config_resolution` | `subworkflow_failed`

---

## 可观测性（Observer）

```ts
interface WorkflowObserver {
  onEvent?(event: WorkflowLifecycleEvent): void | Promise<void>;
}
```

executor **await** `onEvent`，保证顺序。嵌套子 run 的事件会带可选 `parent: { runId, stepId, iteration }`。

| `type` | 时机 |
|---|---|
| `workflow:start` | Run 校验通过后、调度开始前 |
| `workflow:finished` | 汇总结果后 |
| `workflow:cancelled` | 首次进入 cancelling |
| `workflow:paused` / `workflow:resumed` | 暂停完成 / 恢复 |
| `workflow:iteration:start` / `:finished` | 父视角下的子工作流每一轮 |
| `step:queued` | 进入资源等待堆 |
| `step:start` | 拿到资源后、真正执行前 |
| `step:finished` | 步骤结束（含失败与跳过；无单独 error 事件） |
| `plugin:log` | 插件通过 context logger 输出 |

插件侧 logger 由引擎注入（`createContextLogger`），串行入队到 `plugin:log`；步骤结束前会 `flush`。

---

## 插件管理

engine 透传：

- `registerPlugin` / `registerPlugins` / `unregisterPlugin`
- `getPlugin` / `getPlugins` / `getPluginNames` / `hasPlugin`

`executePlugin` 行为：

1. 未注册 → `{ success: false, code: PLUGIN_NOT_FOUND }`
2. `PluginCancelledError` → `PLUGIN_CANCELLED`（executor 转为 `SKIPPED`）
3. 其它 throw → `PLUGIN_EXECUTION_ERROR`
4. 正常返回插件自己的 `PluginResult`

注入到插件的 context 字段名见 `WorkflowContextKeys` / `PluginContextKeys`（含 `runId`、`stepId`、`previousResults`、`previousResultsData`、`state`、`logger`、`signal` 等）。调用方传入的 `runId` 会被剥离，由内核写入真实 `workflowRunId`。

---

## `createEngine` API

```ts
createEngine(options?: EngineOptions)
```

### 选项摘要

| 选项 | 默认 | 说明 |
|---|---|---|
| `plugins` | — | 启动时注册 |
| `maxParallelSteps` | `1` | 步骤并行度 |
| `failFast` | `true` | 失败即停调度 |
| `scheduler` | — | 传给 `createTaskScheduler` |
| `resources` | — | 传给资源池；引擎强制 `autoCleanup: false` |
| `initialResources` | — | 预注册资源 |
| `defaultPoolSize` | `5` | default 池槽位数 |
| `observer` | — | 生命周期观察者 |
| `inFlightTimeoutMs` | `30000` | hard cancel / pause+abort 超时 |
| `resolveWorkflow` | — | `importId` → 子工作流定义 |
| `embeddedRunHooks` | — | 子 run 建行 / 收尾回调 |
| `maxNestingDepth` | `3` | 嵌套上限 |

### 返回方法

| 方法 | 说明 |
|---|---|
| `runWorkflow(runId, workflow, context?, callOptions?)` | 同步 await 至 Run 结束 |
| `scheduleWorkflow(...)` | 经调度器异步投递；`retryable: false` |
| `cancelRun` / `pauseRun` / `resumeRun` / `getRunStatus` | Run 控制 |
| `cancelScheduledTask` / `getScheduledTaskId` | 调度器侧 |
| `registerPlugin(s)` 等 | 插件表 |
| `registerResource` | 注册资源（池满抛错） |
| `getResourceManager` / `getResourceWaitQueue` / `getScheduler` / `getExecutor` | 子模块句柄 |
| `destroy` | 取消活跃 Run、销毁等待队列与资源池、清空执行历史（**不**自动清空插件表） |

`scheduleWorkflow` 的任务失败不会按调度器重试：业务失败通常不 throw，且整次重跑非幂等。

---

## 子模块工厂（高级）

需要定制接线时可直接使用：

```ts
import {
  createWorkflowExecutor,
  createTaskScheduler,
  createPluginManager,
  createResourceManager,
  createResourceWaitQueue,
  validateDag,
  validateStepKinds,
  validateWorkflowNesting,
  validateWorkflowContextReferences,
  resolveConfigReferences,
  jsonSchemaToZod,
  deriveChildRunId,
} from '@monai-devops/core-engine';
```

- **`createWorkflowExecutor`**：无资源钩子时的纯编排；适合单测 DAG / 嵌套 / Run 控制。
- **`createTaskScheduler`**：`maxConcurrency` / `retryAttempts` / `retryDelay`；小顶堆按 priority + `createdAt`。
- **`createResourceManager`**：独立使用时可开 `autoCleanup`（引擎路径关闭）。

---

## 错误类型

| 类 | 场景 |
|---|---|
| `WorkflowValidationError` | DAG / kind / `$ref` / stateSchema / nesting 等启动前校验 |
| `WorkflowRunIdValidationError` | `workflowRunId` 非法 |
| `RunAlreadyActiveError` | 同 id 重复活跃 Run |
| `StepExecutionError` | 步骤基础设施失败（含 `kind`） |
| `ResourceQueueCancelledError` | 资源等待被取消或队列销毁 |
| `ResourceRegistrationError` | 资源池已满无法注册 |
| `StateSchemaConversionError` | JSON Schema → Zod 失败 |

---

## 目录结构

```
packages/core-engine/
├── index.ts                 # 公共导出
├── engine/                  # createEngine 门面
├── executor/                # DAG 执行、步骤形态、state、$ref、嵌套、RunHandle
├── scheduler/               # 任务优先级队列
├── resource/                # 资源池 + 等待队列
├── plugin/                  # 插件管理器 + context logger
├── observer/                # 事件常量与类型
├── utils/min-heap.ts
├── errors.ts
├── context-keys.ts
└── __tests__/
```

## 开发脚本

| 脚本 | 作用 |
|---|---|
| `pnpm build` | 清空 `dist` 后 `tsc -p tsconfig.build.json` |
| `pnpm check-types` | 类型检查 |
| `pnpm test` | `node scripts/run-tests.mjs`（基于 Node test runner） |
| `pnpm lint` / `lint:fix` | ESLint |
| `pnpm format` / `format:check` | Prettier |

发布物仅包含 `dist/`（`main` / `types` / `exports` 指向 `./dist/index.js` 与 `.d.ts`）。
