# @monai-devops/core-engine 开发日志

> 依据 [core-engine.md](../plans/core-engine.md) **计划 A · 运行控制（中断 / 暂停 / 继续）**，为编排内核补齐 Run 注册、主动 cancel / pause / resume、observer 控制事件与结果模型扩展。

**日期**：2026-07-06（工作区变更，尚未提交）

---

## 背景与目标

### 改造前

- `runWorkflow` / `scheduleWorkflow` 为一次性 Promise，提交后无法按 `workflowRunId` 寻址控制
- 「中止」仅存在于内部：`failFast` 停止调度、`onWorkflowAbort` 取消资源队列，**无对外 API**
- observer 仅有 6 种生命周期事件，无法区分用户取消 / 暂停与 failFast 中止
- `WorkflowRunResult` 无 `cancelled` 终态；server 只能绕过内核直接写库 + `cancelByWorkflowRunId`

### 改造后

- 每个 `executeWorkflow` 实例注册到 **Run 注册表**，控制操作以 `workflowRunId` 为主键
- 对外暴露 **`cancelRun` / `pauseRun` / `resumeRun` / `getRunStatus`**（engine 门面透传 executor）
- **尽力取消（best-effort）** 闭环：停止调度未开始步骤、取消资源等待、in-flight 跑完后终态 `cancelled`
- **暂停 / 继续（P1）**：调度 gate 冻结/恢复 ready 队列，`waitInFlight` 默认策略
- **硬取消（P2 预埋）**：`mode: 'hard'` 注入 `AbortSignal`，`inFlightTimeoutMs` 超时后将 in-flight 步骤标为 `user_cancelled`
- observer 新增 **`workflow:cancelled` / `workflow:paused` / `workflow:resumed`**
- failFast 与用户 cancel **共用 `abortReason` 分支**，skipReason 区分 `workflow_aborted` 与 `user_cancelled`

---

## 变更文件一览

| 路径 | 变更 |
| --- | --- |
| `executor/run-registry.ts` | **新增** — 活跃 Run 表、终态缓存、`destroyAll` |
| `executor/run-handle.ts` | **新增** — 单 Run 控制态、per-run 控制链串行化、AbortController 追踪 |
| `executor/index.ts` | 注册表集成、调度 gate、控制 API、hard cancel 超时竞速 |
| `executor/types.ts` | `RunControlStatus`、`RunControlResult`、`WorkflowRunStatus` 等 |
| `engine/index.ts` | 暴露控制 API；`destroy` 先 `destroyActiveRuns`；`cancelRun` 联动 scheduler |
| `scheduler/index.ts` | `cancelScheduledTask` / `cancelScheduledTaskByWorkflowRunId` |
| `observer/event-types.ts` | 新增 3 种控制事件常量 |
| `observer/types.ts` | 控制事件 discriminated union |
| `errors.ts` | `SkipReasons.USER_CANCELLED`、`RunAlreadyActiveError` |
| `context-keys.ts` | `WorkflowContextKeys.signal` |
| `README.md` | 控制 API 与 observer 事件表更新 |
| `__tests__/executor-run-control.test.ts` | **新增** — cancel / pause / resume / destroy / hard cancel 等 |
| `__tests__/scheduler-cancel.test.ts` | **新增** — 调度层按 taskId / workflowRunId 撤销 |
| `packages/plugin-sdk/logger/index.ts` | `PluginContextKeys.signal` |
| `packages/plugin-sdk/README.md` | AbortSignal 插件约定说明 |
| `docs/plans/core-engine.md` | 移除已完成的计划 B 详情，聚焦计划 A 待办 |

---

## 新增 API（`createEngine` 返回值）

| API | 说明 |
| --- | --- |
| `cancelRun(workflowRunId, options?)` | 尽力取消；`options.mode: 'best-effort' \| 'hard'`；**非阻塞**返回 `cancelling` + `inFlightSteps` |
| `pauseRun(workflowRunId, options?)` | 暂停调度；`waitInFlight` 默认 `true`；`abortInFlight` 中断 in-flight |
| `resumeRun(workflowRunId)` | 从 `paused` 恢复，不重复已成功步骤 |
| `getRunStatus(workflowRunId)` | 活跃或终态缓存快照（含 progress） |
| `destroy()` | 先取消所有活跃 Run，再释放资源与历史 |

`createWorkflowExecutor` 同样导出上述控制 API 及 `destroyActiveRuns()`。

---

## 控制态与结果模型

### Run 控制态（`RunControlStatus`）

`running` | `pausing` | `paused` | `cancelling` | `cancelled` | `finished` | `failed` | `unknown`

### 控制操作回执（`RunControlResult`）

```ts
{
  workflowRunId: string;
  action: 'cancel' | 'pause' | 'resume';
  previousStatus: RunControlStatus;
  currentStatus: RunControlStatus;
  mode?: 'best-effort' | 'hard';
  inFlightSteps?: string[];
}
```

### 工作流终态（`WorkflowRunResult`）

- 新增 `status: 'success' | 'failed' | 'cancelled'`
- 用户 cancel / destroy → `status: 'cancelled'`，`success: false`
- 未开始步骤 skipReason：`user_cancelled`（failFast 仍为 `workflow_aborted`）

---

## observer 新事件

| 事件 | 触发时机 |
| --- | --- |
| `workflow:cancelled` | 首次受理 cancel（含 `inFlightSteps`、`mode`） |
| `workflow:paused` | 进入 `paused`（in-flight 跑完后或立即暂停） |
| `workflow:resumed` | `paused` → `running` |
| `workflow:finished` | `result.status` 可为 `cancelled` |

---

## 关键语义决策

1. **cancelRun 非阻塞**：受理后立即返回 `cancelling`，不 `await` workflow 收尾；与 server 决策 F「尽力取消、in-flight 允许跑完」一致。
2. **failFast 与用户 cancel 优先级**：`setFailFastAbort()` 仅在 `abortReason === 'none'` 时生效；用户 cancel 优先。
3. **pause 事件不重复**：`waitInFlight` 路径仅由 executor 主循环 `maybeEmitPaused` 发事件；立即暂停由 `pauseRun` 发一次。
4. **hard cancel 超时**：abort 触发后动态读取 `getCancelMode()`，在 `inFlightTimeoutMs`（默认 30s）内插件未结束则步骤 `SKIPPED / user_cancelled`。
5. **重复 workflowRunId**：活跃 Run 冲突抛出 `RunAlreadyActiveError`。
6. **scheduleWorkflow 层**：`engine.cancelRun` 会先 `cancelScheduledTaskByWorkflowRunId`，撤销尚未进入 executor 的排队 Task。

---

## 测试

`pnpm --filter @monai-devops/core-engine test` — **73** 项通过（run control / scheduler cancel 等）。

新增覆盖：

- duplicate `workflowRunId` 拒绝
- cancel 跳过 ready 步骤、`user_cancelled` 终态、`workflow:cancelled` → `workflow:finished` 顺序
- cancel 幂等、并行独立步骤 cancel
- `getRunStatus` 活跃/终态
- pause → resume 无重复执行
- `destroyActiveRuns` 取消活跃 Run
- engine 层 best-effort cancel
- hard cancel + `inFlightTimeoutMs` 超时
- failFast 与 user cancel 交叉
- pause 事件仅发一次（`waitInFlight`）
- scheduler 按 `taskId` / `workflowRunId` 撤销排队 Task

---

## 与上层对接（同期变更，非本包代码）

| 层 | 对接点 |
| --- | --- |
| **server** | `RunManager.cancelRun` 改调 `engine.cancelRun`；新增 pause/resume 端点；`GET /runs/:id` 合并 `getRunStatus` |
| **web** | 运行详情取消/暂停/继续按钮；`RunState.status` 对齐 `RunStatus`；WS 订阅含 `paused` / `pausing` |

详见 [server.md](./server.md)、[web.md](./web.md)（待同步更新）。

---

## 未完成 / 后续

- [x] `cancelScheduledTask(taskId)` engine 门面暴露
- [x] `pauseRun({ abortInFlight })` + `SkipReasons.PAUSE_INTERRUPTED`
- [x] 并行 cancel/pause、依赖链 pause、协作 signal 测试
- [x] server cancel/pause 请求体透传；web 强制取消
- [x] `docs/plans/core-engine.md` 收束为剩余缺口
- [ ] hard cancel 后插件孤立任务的处理策略（子进程 kill 等）

---

## 2026-07-06 补充（运行控制收尾）

| 变更 | 说明 |
| --- | --- |
| `PauseRunOptions.abortInFlight` | 与 hard cancel 共用 AbortSignal；超时标 `pause_interrupted` |
| 调度主循环 | `paused` / `pausing` 时即使 ready/inFlight 为空也保持等待 resume |
| `engine.cancelScheduledTask` / `getScheduledTaskId` | 调度层撤销 API |
| `plugin-sdk.getAbortSignal` | 插件读取取消信号辅助函数 |
| server | `POST cancel/pause` 请求体；`cancelled: 'best-effort' \| 'hard'` |
| web | 「强制取消」按钮（`mode: 'hard'`） |
| 测试 | +6 项 run control（共 **73** 项通过） |

---

## 参考

- 计划文档：[core-engine.md](../plans/core-engine.md)
- 包 README：[packages/core-engine/README.md](../../packages/core-engine/README.md)
- server 取消语义：[server-api.md](../plans/server-api.md) 决策 F
