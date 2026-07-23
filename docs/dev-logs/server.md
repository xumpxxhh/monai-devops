# apps/server 开发日志

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
