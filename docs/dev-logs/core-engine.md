# @monai-devops/core-engine 开发日志

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
