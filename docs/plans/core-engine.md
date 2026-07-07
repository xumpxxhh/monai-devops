# core-engine 已知问题归档

> 基于 `packages/core-engine` 源码审查（engine / executor / run-handle / run-registry / scheduler / resource-scheduler / resource / plugin / helpers）整理。
>
> 整体评价：分层清晰、错误模型统一、Run 控制与观察者解耦做得较好；下列为当前已识别的 **Bug、隐患与设计债**，按优先级排列，供后续迭代排期。

**关联文档**

- 包说明：[packages/core-engine/README.md](../../packages/core-engine/README.md)
- 服务侧依赖：[server-api.md](./server-api.md) §1.2

---

## 优先级总览

| ID | 优先级 | 问题 | 模块 | 状态 |
| --- | --- | --- | --- | --- |
| CE-001 | 高 | hard cancel 超时后资源提前释放，插件仍在后台运行 | executor / resource | 已修复 |
| CE-002 | 高 | `executionHistory` 按 `workflowId` 键，并发 run 互相覆盖 | executor | 已修复 |
| CE-003 | 高 | `scheduleWorkflow` 重试语义失效且非幂等 | scheduler / engine | 已修复 |
| CE-004 | 中 | `pluginFailureKind` 分支死代码，`failureKind` 无法区分 | executor/helpers | 已修复 |
| CE-005 | 中 | `assertValidWorkflowRunId` 校验 trim 值却使用原始 id | executor | 已修复 |
| CE-006 | 中 | `registerResource` 池满时静默丢弃 | resource / engine | 已修复 |
| CE-007 | 低 | `allocationLock` 伪互斥 + 死代码 | resource | 待清理 |
| CE-008 | 低 | `step:queued` 语义不准且与调度性能耦合 | resource-scheduler / engine | 待优化 |
| CE-009 | 低 | 堆取消为惰性删除，队列长度失真 | scheduler / resource-scheduler | 待优化 |
| CE-010 | 低 | `resourceType` 拼错静默降级到 default 池 | engine | 待增强 |
| CE-011 | 低 | 全内存单进程，无持久化 | 整体 | 已知边界 |
| CE-012 | 低 | observer 抛错导致步骤 FAILED | executor / observer | 待评估 |
| CE-013 | 低 | 测试与 CI 工程化不足 | 工程 | 待增强 |

---

## 高优先级

### CE-001 hard cancel 超时后资源提前释放（孤儿任务）

**位置**：`packages/core-engine/executor/index.ts` — `racePluginWithInFlightAbort`、`executeStep`

**现象**

- `mode: 'hard'` 取消或 `pauseRun({ abortInFlight: true })` 时，向 in-flight 步骤注入 `AbortSignal`。
- 若插件在 `inFlightTimeoutMs`（默认 30s）内未结束，`racePluginWithInFlightAbort` 返回 `'in_flight_abort_timeout'`，步骤标记为 `SKIPPED`。
- 随后 `onStepComplete` / `onStepError` 释放资源，但 **`pluginExecutor` 的 Promise 仍在后台运行**。

**风险**

- 资源已归还池并可被其他步骤分配，旧插件仍在使用 → **资源复用竞态**。
- README「后续规划」已提及孤立任务回收，但当前实现会在超时瞬间就释放资源，不仅是子进程场景的问题。

**建议方向**

- 超时后延迟归还资源，或标记资源为 `quarantined` 直至插件 Promise settle。
- 记录未回收的 in-flight 句柄，供 `destroy()` / 监控查询。
- 与 plugin-sdk 的 `throwIfAborted` / `PluginCancelledError` 协作，明确「超时」与「协作取消」的语义边界。

---

### CE-002 executionHistory 并发 run 互相覆盖

**位置**：`packages/core-engine/executor/index.ts`

**现象**

```ts
const executionHistory: Map<string, ExecutionResult[]> = new Map();
// executeWorkflow 内：
executionHistory.set(workflow.id, finalResults);
// getExecutionHistory(workflowId) 按 workflow 定义 ID 读取
```

同一 `WorkflowDefinition.id` 并发多个 `workflowRunId` 时，历史只保留最后一次 run 的结果，前序 run 被静默覆盖。

**风险**

- 与内核以 `workflowRunId` 隔离活跃 Run 的设计不一致。
- 调用方若用 `getExecutionHistory` 做调试或审计，会得到错误数据。

**建议方向**

- 键改为 `workflowRunId`，或 `Map<workflowRunId, ExecutionResult[]>`。
- 若需按定义 ID 查询，提供显式 API（如「最近一次 run」）并文档化语义。
- 补充并发 run 的单元测试。

---

### CE-003 scheduleWorkflow 重试语义失效且非幂等

**位置**：`packages/core-engine/scheduler/index.ts`、`packages/core-engine/engine/index.ts`

**现象**

1. `runWorkflow` / `executeWorkflow` 对步骤失败**从不 throw**，返回 `{ success: false, status: 'failed' }`。
2. `executeWithRetry` 仅在 `execute()` **抛异常**时重试；工作流业务失败不会触发重试。
3. 若因 DAG / `workflowRunId` 校验抛错而重试，必然再次失败，重试无意义。
4. 即使触发重试，也会**从头重跑整个工作流**，已完成步骤无幂等保证。

**风险**

- `SchedulerOptions.retryAttempts`（默认 3）对 `scheduleWorkflow` 几乎形同虚设，易误导配置方。
- 未来若误用重试，可能重复执行副作用步骤。

**建议方向**

- 明确 `scheduleWorkflow` 的重试策略：仅对基础设施异常重试，或完全移除 workflow 级重试。
- 若保留重试，需定义步骤级幂等键 / checkpoint，或文档声明「不重试、由上层 Run 重放」。
- `ScheduleResult` 区分 `success: false` 来自业务失败 vs 调度异常。

---

## 中优先级

### CE-004 pluginFailureKind 分支死代码

**位置**：`packages/core-engine/executor/helpers.ts`

**现象**

```ts
export function pluginFailureKind(pluginResult: PluginResult): StepFailureKind {
  if (
    pluginResult.code === PluginFailureCodes.PLUGIN_NOT_FOUND ||
    pluginResult.code === PluginFailureCodes.PLUGIN_EXECUTION_ERROR
  ) {
    return StepFailureKinds.PLUGIN;
  }
  return StepFailureKinds.PLUGIN; // 与 if 分支相同
}
```

`PLUGIN_CONFIG_INVALID` 等 code 无法映射到不同 `failureKind`。

**建议方向**

- 删除无意义分支，直接 `return StepFailureKinds.PLUGIN`；或
- 补全分类（如 `PLUGIN_CONFIG_INVALID` → `PLUGIN`，基础设施类 → `INTERNAL`）。

---

### CE-005 workflowRunId trim 校验与使用不一致

**位置**：`packages/core-engine/executor/index.ts` — `assertValidWorkflowRunId`

**现象**

- 校验时对 `id.trim()` 做长度与正则检查。
- 通过后，Registry / 事件 / context 注入均使用**未 trim 的原始字符串**。
- 例如 `" run-1 "` 可通过校验，但 `cancelRun("run-1")` 找不到句柄。

**建议方向**

- 校验通过后统一返回并使用 trim 后的值；或
- 拒绝含首尾空白的输入（与「仅允许 `[A-Za-z0-9_-]+`」的文档承诺一致）。

---

### CE-006 registerResource 池满时静默丢弃

**位置**：`packages/core-engine/resource/index.ts`、`packages/core-engine/engine/index.ts`

**现象**

- `maxResources` 默认 `10`；engine 启动注册 `defaultPoolSize`（默认 5）个 default 资源。
- `initialResources` 或动态 `registerResource` 超过上限时返回 `false`，**无日志、无抛错**。
- engine 构造时未检查 `registerResource` 返回值。

**建议方向**

- engine 构造时根据 `defaultPoolSize + initialResources.length` 自动抬高 `maxResources`。
- 或池满时 `throw`，避免配置静默失效。

---

## 低优先级

### CE-007 allocationLock 伪互斥与死代码

**位置**：`packages/core-engine/resource/index.ts`

**现象**

- `allocateResource` / `releaseResource` 用 `Set` 作锁，但逻辑全同步、无 `await`，JS 单线程下无法真正互斥。
- `allocationLock.add` 后紧跟的 `if (resource.status !== 'available') return null` 在同步路径下不可达。

**建议方向**

- 移除误导性锁与死分支；若未来有异步分配，再引入真正的串行队列。

---

### CE-008 step:queued 语义不准且耦合调度

**位置**：`packages/core-engine/resource-scheduler/index.ts`、`packages/core-engine/engine/index.ts`

**现象**

- `acquire` 无条件调用 `onQueued`，即使资源立即可用、未真正排队。
- `processQueue` 在 `onQueued`（常为 observer 落库）resolve 后才执行 → **可观测性拖慢资源获取**。

**建议方向**

- 仅在真正入堆等待时 emit `step:queued`。
- `onQueued` 与 `processQueue` 解耦（fire-and-forget 或并行）。

---

### CE-009 堆取消为惰性删除

**位置**：`packages/core-engine/scheduler/index.ts`、`packages/core-engine/resource-scheduler/index.ts`

**现象**

- 取消仅标记 `cancelled: true`，需等到项浮至堆顶才移除。
- 大量取消 + 长队列时，内存占用偏高；`getQueueStatus().queueLength` 含已取消项。

**建议方向**

- 维护活跃计数或支持堆内删除 / 定期压缩（视性能需求而定）。

---

### CE-010 resourceType 拼错静默降级

**位置**：`packages/core-engine/engine/index.ts` — `getResourceType`

**现象**

- 步骤 `config.resourceType` 拼错或类型未注册时，行为不明确，可能落到 `default` 池且无警告。

**建议方向**

- 工作流启动前校验：步骤声明的 `resourceType` 在资源池中是否存在（或允许显式 opt-in 到 default）。

---

### CE-011 全内存单进程（已知能力边界）

**现象**

- Run 状态、执行历史、调度队列均在进程内存；重启即丢失。
- 多实例部署无法共享 Run 状态（需 `apps/server` 持久化层补齐）。

**说明**

- README 已列入后续规划；作为编排内核可接受，但应在对外 API 文档中强调「非持久化运行时」。

---

### CE-012 observer 抛错导致步骤 FAILED

**位置**：`packages/core-engine/executor/index.ts`、`createContextLogger`

**现象**

- `plugin:log` 的 `onEvent` 若 throw，当前步骤标记为 `FAILED / INTERNAL`。
- 落库/日志副作用失败可能让业务上成功的步骤变为失败。

**建议方向**

- 评估是否改为记录 observer 错误但不影响步骤状态；或提供 `onObserverError` 钩子供上层决策。

---

### CE-013 测试与 CI 工程化不足

**现象**

- 使用自研 `scripts/run-tests.mjs` + `node:test`，无覆盖率报告。
- 部分问题（CE-002、CE-005、CE-006）缺少回归测试。

**建议方向**

- 接入标准 test runner / coverage；为上述 Bug 补充针对性用例。

---

## 建议修复顺序

1. **快速修复（小 diff、低风险）**：CE-004、CE-005、CE-006
2. **一致性修复**：CE-002（改键 + 测试）
3. **语义设计后实现**：CE-003（重试策略）、CE-001（孤儿任务与资源隔离）
4. **体验与可维护性**：CE-007 ~ CE-010、CE-012
5. **长期**：CE-011（持久化由 server 层承担）、CE-013

---

## 修订记录

| 日期 | 说明 |
| --- | --- |
| 2026-07-07 | CE-004 ~ CE-006 中优先级问题修复 |
| 2026-07-07 | CE-001 ~ CE-003 高优先级问题修复 |
| 2026-07-07 | 初版：源码审查问题归档（13 项） |
