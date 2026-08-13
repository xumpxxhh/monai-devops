# apps/server 开发日志

## 2026-08-12

- **变更**：新增 WorkspaceService（按 runId 创建/清理临时工作区），RunManager 在 executeRun 注入 `workspaceDir` 并在 finally 清理；支持 `CI_WORKSPACE_ROOT`
- **文件**：`src/workspace/workspace.service.ts`, `src/workspace/workspace.module.ts`, `src/runs/run-manager.service.ts`, `src/app.module.ts`, `.env.example`

## 2026-08-10

- **变更**：数据库改为团队公共 Postgres（共享 `monai_devops` / `monai_devops_test`）；移除仓库 compose，补充迁数据与协作说明
- **文件**：`apps/server/.env.example`, `apps/server/.env.test`, `apps/server/README.md`, `docs/ops/postgres-shared.md`, `docker/postgres/init-databases.sql`

## 2026-08-05

- **变更**：`WorkflowImportRecord` 新增 `childStateSchema` 透传子工作流 stateSchema；`normalize-workflow-ids` 保留 `WORKFLOW_STATE_REF_ID` 不重映射
- **文件**：`workflows/prisma-workflow.repository.ts`, `workflows/workflows.repository.ts`, `common/validation/normalize-workflow-ids.ts`, `common/validation/normalize-workflow-ids.spec.ts`

## 2026-07-24

- **变更**：工作流可组合化服务端（阶段 4）：Prisma 新增 WorkflowImport / ownerWorkflowId / parentRunId、resolveWorkflow(importId) 两跳查库注入、POST/GET /imports（copy 建私有 Workflow）、GET /step-kinds、initialState Zod 强校验、validate 复用 core-engine 并接入新校验、normalize-workflow-ids 适配 importId、DELETE 应用层预检 409
- **文件**：`prisma/schema.prisma`, `src/engine/engine.service.ts`, `src/workflows/*`, `src/runs/*`, `src/common/validation/*`
- **变更**：步骤名重复校验（validate-workflow）+ POST /imports 前置判重
- **文件**：`src/common/validation/validate-workflow.ts`, `src/workflows/workflows.service.ts`
- **变更**：子工作流执行不再落独立 Run 行；嵌套事件写入并推流到顶层父 run；`GET /runs/:runId/children` 恒返回空列表
- **文件**：`src/runs/run-manager.service.ts`, `src/runs/runs.controller.ts`, `src/runs/run-manager.nested-events.spec.ts`

## 2026-07-05

- **变更**：合并流式 `plugin:log` 并优化事件缓冲裁剪；WS 出站附带 `runId`，按 run 串行处理内核事件
- **文件**：`src/common/serialization/merge-stream-log-event.ts`, `src/runs/in-memory-run.repository.ts`, `src/runs/run-manager.service.ts`, `src/runs/run-stream.service.ts`

## 2026-07-03

- **变更**：dry-run 改造为 SSE 流式响应
- **文件**：`src/plugins/plugins.controller.ts`, `src/plugins/plugins.service.ts`

## 2026-07-02

- **变更**：新增 `GET /plugins/:name/config-schema`（Zod → JSON Schema）
- **文件**：`src/plugins/plugin-config-schema.ts`, `src/plugins/plugins.controller.ts`

## 2026-07-01

- **变更**：test-devops 改用共享 Engine；引入 `WorkflowDraft` 与 ID 规范化；插件注册表 + `pnpm sync:plugins`
- **文件**：`src/test-devops/*`, `src/common/validation/normalize-workflow-ids.ts`, `src/plugins/plugin-registry.ts`

## 2026-06-30

- **变更**：搭建核心业务模块（Engine / Runs / Workflows / Plugins / Resources / Stats / Health）
- **文件**：`src/engine/*`, `src/runs/*`, `src/workflows/*`, `src/plugins/*`, `src/resources/*`, `src/stats/*`, `src/health/*`

## 2026-06-09

- **变更**：WebSocket 实时推送与 `plugin:log` 序列化
- **文件**：`src/runs/runs.gateway.ts`, `src/common/serialization/serialize-workflow-event.ts`

## 2026-06-05

- **变更**：重构测试模块为 test-devops，增加 observer 日志
- **文件**：`src/test-devops/*`

## 2026-06-04

- **变更**：集成 core-engine 闭环测试与 ConfigModule
- **文件**：`src/app.module.ts`, `src/test-devops/*`

## 2026-06-03

- **变更**：搭建 NestJS 后端服务
- **文件**：`apps/server/**`
