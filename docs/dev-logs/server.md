# apps/server 开发日志

> 依据 [server-api.md](../plans/server-api.md) 将 `apps/server` 从「3 个验证端点」升级为完整的 DevOps API 服务，并持续迭代至当前版本。

**最近更新**：2026-07-06

---

## 背景与目标

### 改造前（2026-06 初）

- 仅有 `GET /`、`GET /test-devops`、`WS /test-devops/ws` 三个端点
- 每次 run 临时 `createEngine` 后 `destroy`，资源池 per-run 独享，无法产生真实排队
- observer 仅向单个 WS 连接回推，无历史、无回放
- 无持久化、无统一异常契约、HTTP 与 WS 前缀来源分裂

### 当前状态（2026-07-06）

- `server = core-engine 的网络运行时`：编排逻辑全部委托内核，服务负责协议适配、Run 状态机、事件缓冲/回放/扇出
- 共享单例 Engine，多 Run 共用资源池，队列可观测
- Run 作为一等资源，REST + WS 双通道读写
- 分层模块边界清晰，仓储接口可替换（本期 InMemory 实现）
- 工作流草稿（`WorkflowDraft`）支持省略 ID、`clientRef` 依赖编排
- 插件 config JSON Schema 暴露，dry-run 改为 SSE 流式
- 流式 `plugin:log` 合并缓冲，WS 出站附带 `runId`，按 run 串行处理内核事件

---

## 迭代时间线

| 日期 | 提交 | 摘要 |
| --- | --- | --- |
| 2026-06-03 | `1e912a5` | 搭建 NestJS 后端服务 |
| 2026-06-04 | `4c8480c` | 集成 core-engine 闭环测试与 ConfigModule |
| 2026-06-05 | `f4016da` | 重构测试模块为 test-devops，增加 observer 日志 |
| 2026-06-09 | `ae3cae3` / `a0487ee` | WebSocket 实时推送 + `plugin:log` 序列化 |
| 2026-06-30 | `b79b18e` | **核心业务模块架构**（Engine / Runs / Workflows / Plugins / Resources / Stats / Health） |
| 2026-07-01 | `1004a3b` | test-devops 改用共享 Engine |
| 2026-07-01 | `087f9dd` | 引入 `WorkflowDraft` 与 ID 自动规范化 |
| 2026-07-01 | `2aaeccc` | 插件基础设施重构，注册表 + `pnpm sync:plugins` |
| 2026-07-02 | `4249bab` | 新增 `GET /plugins/:name/config-schema` |
| 2026-07-03 | `69789f3` | dry-run 改造为 SSE 流式响应 |
| 2026-07-05 | `60d803a` | 合并流式 `plugin:log` 并优化事件缓冲裁剪策略 |
| 2026-07-05 | `d4a9894` | WebSocket 出站附带 `runId`，按 run 串行处理内核事件 |

---

## 架构分层

```
Transport（REST / WS / SSE）
    ↓
Application（RunManager、WorkflowsService、PluginsService、ResourcesService、StatsService）
    ↓
Engine 适配（EngineService — 内核唯一 import 点）
    ↓
仓储（RunRepository、WorkflowRepository — 接口 + InMemory*）
```

| 模块 | 路径 | 说明 |
| --- | --- | --- |
| `common/` | `filters/`、`serialization/`、`validation/`、`dto/` | 异常过滤、事件序列化、流式 log 合并、DAG 校验、ID 规范化、分页 |
| `engine/` | `engine.service.ts` | 共享 Engine 单例 + 全局 observer 分发 |
| `runs/` | `run-manager`、`run-stream`、`runs.repository` | Run 状态机、事件缓冲、WS 扇出（`@Global` 模块） |
| `workflows/` | CRUD + validate + trigger run | 工作流定义管理，接受 `WorkflowDraft` |
| `plugins/` | 只读 + config-schema + SSE dry-run | 插件注册表暴露、Zod → JSON Schema |
| `resources/` | 资源池 + 队列状态 | 调度可观测性 |
| `stats/` | overview 聚合 | 活跃 Run、成功率、排队等 |
| `health/` | `healthz` | 存活与 Engine 就绪 |
| `test-devops/` | 兼容层 | 保留旧端点，内部走 RunManager |

`RunsModule` 标记为 `@Global()`，由 `WorkflowsModule`、`StatsModule`、`TestDevopsModule` 引入后在全局可用；`app.module.ts` 不直接注册 Runs。

---

## 目录结构（当前）

```
apps/server/src/
├── common/
│   ├── filters/all-exceptions.filter.ts
│   ├── serialization/
│   │   ├── serialize-workflow-event.ts
│   │   └── merge-stream-log-event.ts      # 流式 stdout/stderr 合并
│   ├── validation/
│   │   ├── validate-workflow.ts
│   │   └── normalize-workflow-ids.ts      # WorkflowDraft → WorkflowDefinition
│   └── dto/pagination.dto.ts
├── engine/
│   ├── engine.module.ts
│   └── engine.service.ts
├── runs/
│   ├── runs.module.ts                     # @Global
│   ├── runs.controller.ts
│   ├── runs.gateway.ts
│   ├── runs.repository.ts
│   ├── in-memory-run.repository.ts        # 含流式 log 合并 + 智能裁剪
│   ├── run-manager.service.ts             # 按 runId 串行事件链
│   └── run-stream.service.ts              # WS 扇出，出站附带 runId
├── workflows/
│   ├── workflows.module.ts
│   ├── workflows.controller.ts
│   ├── workflows.service.ts
│   ├── workflows.repository.ts
│   └── in-memory-workflow.repository.ts
├── plugins/
│   ├── plugins.module.ts
│   ├── plugins.controller.ts              # dry-run 使用 @Sse()
│   ├── plugins.service.ts
│   ├── plugin-registry.ts                 # AUTO-GENERATED，pnpm sync:plugins
│   └── plugin-config-schema.ts            # Zod → JSON Schema
├── resources/
├── stats/
├── health/
└── test-devops/
    ├── validate-workflow-payload.ts
    └── ...
```

---

## 关键工程决策

| 决策 | 实现 |
| --- | --- |
| **A · 共享单例 Engine** | `EngineService.onModuleInit` 创建，`onModuleDestroy` 销毁 |
| **B · 并发下沉内核** | 不自行排队；可选 `MAX_ACTIVE_RUNS` 软上限返回 429 |
| **C · 缓冲 + 回放 + 扇出** | `RunRecord.events[]` + `RunStreamService`；订阅时先回放再实时 |
| **D · 仓储抽象** | `RunRepository` / `WorkflowRepository` 接口 + InMemory，LRU 淘汰 |
| **E · 错误契约** | `AllExceptionsFilter`；`WorkflowValidationError` → 400；Error 序列化仅在 Engine 适配层 |
| **F · 尽力取消** | `cancelQueuedSteps` + 响应 `cancelled: 'best-effort'` |
| **G · 配置统一** | `GLOBAL_API_PREFIX` 同时用于 HTTP 与 WS path |
| **H · WorkflowDraft** | `normalizeWorkflowIds` 自动生成 workflow / step UUID；`clientRef` 解析 `dependsOn` |
| **I · 流式 log 合并** | 同 step、同 stream（stdout/stderr）的连续 `plugin:log` 合并为单条；超限时优先裁剪 log |
| **J · 事件串行处理** | `RunManagerService.eventChains` 按 `runId` 串行 `processEngineEvent`，避免并发写缓冲 |
| **K · WS 多 run 订阅** | 出站 `event` / `done` 均附带 `runId`，客户端可同连接订阅多个 Run |
| **L · dry-run SSE** | `POST /plugins/:name/dry-run` 返回 `text/event-stream`；`log` → `done` / `error` |

---

## Run 状态机

```
queued → running → finished | failed
queued → rejected（DAG 校验失败，同步）
running → cancelled（尽力取消）
```

`RunRecord` 聚合：`runId`、`workflowSnapshot`、`status`、`counts`、`startedAt` / `finishedAt`、`result`、`events[]`、`traceId`。

---

## API 清单

完整请求/响应契约见 [api-list.md](./api-list.md)。

前缀均为 `/{GLOBAL_API_PREFIX}`（当前 `.env` 配置为 `api/v1/devops`）。

| 分组 | 端点数 | 要点 |
| --- | --- | --- |
| Health / Plugins | 5 | 含 `config-schema`、SSE `dry-run` |
| Workflows | 7 | 接受 `WorkflowDraft`，`validate` 不持久化 |
| Runs | 6 | 核心资源，事件缓冲可 REST 回放 |
| Resources / Stats | 3 | 资源池与聚合概览 |
| Test DevOps | 1 HTTP + 2 WS | 兼容旧协议 |
| WebSocket | `/runs/ws`、`/test-devops/ws` | 出站含 `runId` |

---

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `GLOBAL_API_PREFIX` | **必填** | HTTP 全局前缀 + WS path |
| `PORT` | `3000` | 监听端口 |
| `MAX_PARALLEL_STEPS` | `1` | 步骤并行上限 |
| `RESOURCE_POOL_SIZE` | `5` | 默认资源池槽位数 |
| `MAX_ACTIVE_RUNS` | `50` | 活跃 Run 软上限 |
| `RUN_HISTORY_LIMIT` | `500` | Run 历史 LRU 上限 + 单 Run 事件缓冲上限 |

---

## 验证情况

- [x] `pnpm run build` 通过
- [x] 本地启动成功，路由映射完整
- [x] `GET /healthz`、`GET /plugins`、`GET /plugins/:name/config-schema` 手工验证通过
- [x] `POST /runs`、`GET /runs`、Run 生命周期事件 REST 查询通过
- [x] SSE dry-run 流式 `plugin:log` → `done` 验证通过
- [x] WS 出站 `runId` 字段、多 run 订阅验证通过
- [x] 已补充单元测试文件（`normalize-workflow-ids`、`merge-stream-log-event`、`in-memory-run.repository`、`plugins.service` 等）
- [ ] 单元测试 / e2e：Jest ESM 配置存在 `exports is not defined` 问题（7 个 suite 均无法启动），待单独修复

---

## 已知限制与后续迭代

本期**未实现**（接口形态已预留）：

- 鉴权（JWT / API Key）
- 限流、OpenAPI / Swagger
- 插件动态注册 API
- `scheduleWorkflow` task 队列暴露
- 数据库持久化（替换 `InMemory*`）
- 内核 `AbortSignal` 真取消
- 全局 `ValidationPipe`（需安装 `class-validator`；当前入参校验在 Service 层手动完成）

建议下一步：

1. 修复 Jest ESM 配置，恢复单元测试与 e2e 自动化
2. 安装 `class-validator` 并补充 DTO
3. 按 [web-ui.md](../plans/web-ui.md) §10 做前后端联调验收

---

## 参考文档

- 设计方案：[docs/plans/server-api.md](../plans/server-api.md)
- 接口契约：[docs/dev-logs/api-list.md](./api-list.md)
- 前端对照：[docs/plans/web-ui.md](../plans/web-ui.md) 附录 / §10
