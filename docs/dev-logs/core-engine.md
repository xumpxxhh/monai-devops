# @monai-devops/core-engine 开发日志

## 2026-09-24

- **变更**：Core-2 增加 signal/timer 唤醒条件契约及校验；server 将等待条件、wakeReadyAt 与载荷存入 Attempt，以事务保存 checkpoint 并切换 waiting，定时扫描将到期等待标记为 ready 或 timed_out。
- **边界**：当前是持久化等待/唤醒仓储闭环；执行器尚未消费 ready Attempt，也尚未从 checkpoint 自动续跑 Run。
- **验证**：core-engine 142 项、server 79 项测试（含等待仓储 PostgreSQL 集成）通过；开发库与测试库迁移成功，类型检查和 lint 通过。

## 2026-09-23

- **变更**：完成 Core-1a 执行身份与源事件顺序：为工作流步骤注入稳定的 Job/Attempt identity，覆盖成功、失败、跳过、取消及未调度路径；顶层与嵌套 Run 共用单调事件序列。
- **变更**：明确内核 `sequence` 与数据库 `eventIndex` 独立；服务端合并连续流日志时以 `sequence`/`sequenceEnd` 保存源事件范围。
- **变更**：完成 Core-1b 事件回放契约：新增 `eventVersion`、`occurredAt` 和持久化 `offset`，WebSocket 从真实 eventIndex 回放，修复事件裁剪后数组下标与 offset 错位。
- **变更**：完成 Core-1c 结果原因契约：新增兼容性的 `ExecutionReason`、Run `terminalReason` 和取消事件 reason，统一失败、跳过、取消与中断分类；Core-1 整体验收完成。
- **变更**：启动 Core-2 可靠执行基础：新增 Attempt 状态机、retry/idempotency 契约、lease/heartbeat/checkpoint 类型，以及 Job/Attempt Prisma 模型和原子仓储操作。
- **变更**：接通顶层 step 事件与 Job/Attempt 权威状态，增加本地 lease owner、周期 heartbeat、终态清理和启动过期 lease 扫描；修复终态 Attempt 可因过期 lease 被误领的问题。
- **变更**：新增引擎 `beforeStepExecute` 授权闸门；服务端在 `step:start` 和插件调用前同步取得数据库 lease，授权失败不执行插件。
- **变更**：完成进程内 retry/new Attempt 闭环：步骤显式声明 retry policy，可重试失败保持 jobId 并递增 attempt；支持指数 backoff 上限，中间失败不污染 Run 步骤计数，server/web 全链路保留策略字段。
- **变更**：完成跨进程 Run 控制闭环：pause/resume/cancel 先持久化为控制命令，由实际持有 RunHandle 的 Executor 轮询并原子认领；支持认领超时重领、queued Run 无 owner 取消，以及兼容旧客户端的即时控制响应。
- **决策**：Job/Attempt 使用独立持久化表；未来 retry 保持 `jobId`、递增 `attempt`，checkpoint 归属 Job 并记录来源 Attempt，lease 绑定 Attempt，本地与远程 Executor 共用身份协议。嵌套执行在子 Run 存储模型明确前暂不投影。
- **决策**：默认 `maxAttempts=1` 保持旧工作流行为；只有 infrastructure/internal 原因且步骤显式允许时重试，业务、配置、依赖和取消失败不重试。
- **验证**：core-engine 141 项、server 76 项（含 PostgreSQL 集成）、web 46 项测试通过；受影响范围类型检查、lint 和构建通过；本地 API retryPolicy 以及 pause/resume 控制命令提交、执行、持久化与清理冒烟通过。
- **文件**：`executor/execution-identity.ts`, `executor/index.ts`, `executor/types.ts`, `observer/*`, `apps/server/src/common/serialization/*`, `apps/server/src/runs/run-event-merge*`, `docs/plans/core-engine/core-1-execution-identity-draft.md`

## 2026-08-05

- **变更**：新增 `WORKFLOW_STATE_REF_ID` 工作流 state 引用机制 — `resolveConfigReferences` 支持 `runState` 解析、`validateWorkflowContextReferences` 校验 `stateSchema` 声明、`isWorkflowStateRef` 检测哨兵值
- **文件**：`executor/context-reference.ts`, `executor/index.ts`, `__tests__/context-reference.test.ts`

## 2026-07-24

- **变更**：工作流可组合化内核（阶段 1-3）：WorkflowStep 判别联合（Plugin/SetState/WorkflowRef）、stateSchema → Zod 强校验、workflow 步骤单次/循环执行、内置步骤清单、子 runId 派生、嵌套校验（引用环/深度/循环嵌循环）、RunHandle pause/resume/cancel 订阅与级联、observer parent 字段 + WORKFLOW_ITERATION 事件
- **文件**：`executor/types.ts`, `executor/index.ts`, `executor/state-schema.ts`, `executor/builtin-step-kinds.ts`, `executor/step-kind-validation.ts`, `executor/workflow-nesting.ts`, `executor/child-run-id.ts`, `executor/context-reference.ts`, `executor/run-handle.ts`, `engine/index.ts`, `observer/*`, `errors.ts`, `context-keys.ts`, `__tests__/workflow-composable.test.ts`
- **变更**：`scheduleWorkflow` 透传 `ExecuteWorkflowCallOptions`；README 补充工作流引用/循环与内置步骤清单
- **文件**：`engine/index.ts`, `README.md`, `__tests__/engine.integration.test.ts`
- **变更**：嵌套子工作流的 `step:queued` 改为经 executor `emit` 发出，自动注入 `parent`，避免并入父 run 后污染父 DAG
- **文件**：`executor/types.ts`, `executor/index.ts`, `engine/index.ts`, `__tests__/observer.test.ts`

## 2026-07-06

- **变更**：补齐 Run 注册与 cancel/pause/resume；observer 增加控制事件；终态支持 `cancelled`；hard cancel / abortInFlight 预埋
- **文件**：`executor/run-registry.ts`, `executor/run-handle.ts`, `executor/index.ts`, `engine/index.ts`, `scheduler/index.ts`, `observer/*`, `__tests__/executor-run-control.test.ts`
