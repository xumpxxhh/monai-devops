# core-engine 开发计划

> 本文档收录 `@monai-devops/core-engine` 的**未完成**阶段性开发计划。
>
> **已完成（不再收录详情）**：
>
> - 执行实例 ID 与事件寻址（`workflowRunId` 三入参 API、启动前校验、事件顶层寻址、server/web 适配）
> - **计划 A · 运行控制（P0–P1 + P2 主体）**：Run 注册表、`cancelRun` / `pauseRun` / `resumeRun` / `getRunStatus`、observer 控制事件、`WorkflowRunResult.status`、failFast 与用户 cancel 统一、`mode: 'hard'` AbortSignal、`pauseRun({ abortInFlight })`、`engine.cancelScheduledTask` / `getScheduledTaskId`；server/web 已对接。详见 [`packages/core-engine/README.md`](../../packages/core-engine/README.md) 与 [`docs/dev-logs/core-engine.md`](../dev-logs/core-engine.md)。

---

## 剩余缺口（计划 A 收尾）

### 1. 插件孤立任务策略 — P2

**现状**：`mode: 'hard'` / `pauseRun({ abortInFlight: true })` 在 `inFlightTimeoutMs` 超时后将步骤标为 `SKIPPED`（`user_cancelled` / `pause_interrupted`），但**不**强制 kill 插件子进程或外部任务。

**待明确/实现**（可选，属运维增强）：

- 未协作插件在超时后的资源释放与审计约定
- 是否由 plugin-sdk 提供「子进程包装器」统一监听 `getAbortSignal(context)`

### 2. 跨层协作说明 — P2

| 项 | 状态 |
| --- | --- |
| `POST /runs/:runId/cancel` 请求体 `{ mode?: 'best-effort' \| 'hard' }` | 已实现 |
| `POST /runs/:runId/pause` 请求体 `{ waitInFlight?, abortInFlight? }` | 已实现（web 暂停 UI 仍默认 `waitInFlight: true`） |
| `GET /runs/:runId` 合并 `getRunStatus` | 已实现 |
| `MAX_ACTIVE_RUNS` 与 scheduler 层限流协作文档 | 待补充（server 策略层） |

### 3. 已定案语义（供后续 issue 引用）

| 问题 | 定案 |
| --- | --- |
| pause 时 resource-scheduler 队列 | **保持排队**；pause 只阻塞从 ready 队列取新步骤 |
| cancel 终态 `success` | `status: 'cancelled'` 时 `success: false` |
| skipReason 细分 | `user_cancelled`（用户 cancel）、`workflow_aborted`（failFast）、`pause_interrupted`（pause abortInFlight） |
| AbortSignal 路径 | executor 注入 `PluginContextKeys.signal`；plugin-sdk 提供 `getAbortSignal` |
| 控制 API 并发 | per-run `controlChain` 串行化足够 |

---

## 非目标（不变）

- 跨进程 / 分布式 Run 迁移与持久化 checkpoint
- DAG 热更新后从中断点继续
- 内核内建自动 pause/cancel 策略
- 多 Engine 实例间 Run 协调
