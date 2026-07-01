# apps/server 开发日志

> 依据 [server-api.md](../plans/server-api.md) 将 `apps/server` 从「3 个验证端点」升级为完整的 DevOps API 服务。

**日期**：2026-06-30

---

## 背景与目标

### 改造前

- 仅有 `GET /`、`GET /test-devops`、`WS /test-devops/ws` 三个端点
- 每次 run 临时 `createEngine` 后 `destroy`，资源池 per-run 独享，无法产生真实排队
- observer 仅向单个 WS 连接回推，无历史、无回放
- 无持久化、无统一异常契约、HTTP 与 WS 前缀来源分裂

### 改造后

- `server = core-engine 的网络运行时`：编排逻辑全部委托内核，服务负责协议适配、Run 状态机、事件缓冲/回放/扇出
- 共享单例 Engine，多 Run 共用资源池，队列可观测
- Run 作为一等资源，REST + WS 双通道读写
- 分层模块边界清晰，仓储接口可替换（本期 InMemory 实现）

---

## 架构分层

```
Transport（REST / WS）
    ↓
Application（RunManager、WorkflowsService、PluginsService、ResourcesService、StatsService）
    ↓
Engine 适配（EngineService — 内核唯一 import 点）
    ↓
仓储（RunRepository、WorkflowRepository — 接口 + InMemory*）
```

| 模块 | 路径 | 说明 |
| --- | --- | --- |
| `common/` | `filters/`、`serialization/`、`validation/`、`dto/` | 异常过滤、事件序列化、DAG 校验、分页 |
| `engine/` | `engine.service.ts` | 共享 Engine 单例 + 全局 observer 分发 |
| `runs/` | `run-manager`、`run-stream`、`runs.repository` | Run 状态机、事件缓冲、WS 扇出 |
| `workflows/` | CRUD + validate + trigger run | 工作流定义管理 |
| `plugins/` | 只读 + dry-run | 插件注册表暴露 |
| `resources/` | 资源池 + 队列状态 | 调度可观测性 |
| `stats/` | overview 聚合 | 活跃 Run、成功率、排队等 |
| `health/` | `healthz` | 存活与 Engine 就绪 |
| `test-devops/` | 兼容层 | 保留旧端点，内部走 RunManager |

---

## 新增 / 调整的文件

### 新增

```
apps/server/src/
├── common/
│   ├── filters/all-exceptions.filter.ts
│   ├── serialization/serialize-workflow-event.ts
│   ├── validation/validate-workflow.ts
│   └── dto/pagination.dto.ts
├── engine/
│   ├── engine.module.ts
│   └── engine.service.ts
├── runs/
│   ├── runs.module.ts
│   ├── runs.controller.ts
│   ├── runs.gateway.ts
│   ├── runs.repository.ts
│   ├── in-memory-run.repository.ts
│   ├── run-manager.service.ts
│   └── run-stream.service.ts
├── workflows/
│   ├── workflows.module.ts
│   ├── workflows.controller.ts
│   ├── workflows.service.ts
│   ├── workflows.repository.ts
│   └── in-memory-workflow.repository.ts
├── plugins/
├── resources/
├── stats/
└── health/
```

### 调整

| 文件 | 变更 |
| --- | --- |
| `main.ts` | 全局 `AllExceptionsFilter`、`enableShutdownHooks`（Engine 优雅销毁） |
| `app.module.ts` | 注册 Engine / Runs / Workflows / Plugins / Resources / Stats / Health 模块 |
| `test-devops.service.ts` | 改用共享 `EngineService`，不再 per-run 建/毁 Engine |
| `test-devops.gateway.ts` | 委托 `RunManager` + `RunStreamService`，支持多连接订阅 |
| `test-devops.service.spec.ts` | Mock `EngineService` 适配新结构 |
| `test/app.e2e-spec.ts` | workflow `config.type` 改为 `integration`（与 test-plugin 一致） |
| `package.json` | `start:prod` 路径修正为 `dist/src/main` |

### 删除 / 迁移

- `test-devops/serialize-workflow-event.ts` → 迁移至 `common/serialization/`

---

## API 清单

前缀均为 `/{GLOBAL_API_PREFIX}`（当前 `.env` 配置为 `api/v1/devops`）。

### Engine / Plugins

| 方法 | 路径 |
| --- | --- |
| GET | `/healthz` |
| GET | `/plugins` |
| GET | `/plugins/:name` |
| POST | `/plugins/:name/dry-run` |

### Workflows

| 方法 | 路径 |
| --- | --- |
| GET / POST | `/workflows` |
| POST | `/workflows/validate` |
| GET / PUT / DELETE | `/workflows/:id` |
| POST | `/workflows/:id/run` |

### Runs（核心）

| 方法 | 路径 |
| --- | --- |
| GET / POST | `/runs` |
| GET | `/runs/:runId` |
| GET | `/runs/:runId/events` |
| POST | `/runs/:runId/cancel` |
| DELETE | `/runs/:runId` |

### Resources / Stats

| 方法 | 路径 |
| --- | --- |
| GET | `/resources` |
| GET | `/resources/queue` |
| GET | `/stats/overview` |

### WebSocket

| 路径 | 入站消息 | 说明 |
| --- | --- | --- |
| `/runs/ws` | `subscribe` / `unsubscribe` / `run` | 主通道：订阅 runId、回放 + 实时扇出 |
| `/test-devops/ws` | `run` | 兼容旧协议，内部 = 受理 Run + 自动订阅 |

出站协议沿用：`event` / `done` / `error`。

---

## 关键工程决策落地

| 决策 | 实现 |
| --- | --- |
| **A · 共享单例 Engine** | `EngineService.onModuleInit` 创建，`onModuleDestroy` 销毁 |
| **B · 并发下沉内核** | 不自行排队；可选 `MAX_ACTIVE_RUNS` 软上限返回 429 |
| **C · 缓冲 + 回放 + 扇出** | `RunRecord.events[]` + `RunStreamService` |
| **D · 仓储抽象** | `RunRepository` / `WorkflowRepository` 接口 + InMemory，LRU 淘汰 |
| **E · 错误契约** | `AllExceptionsFilter`；`WorkflowValidationError` → 400；Error 序列化仅在 Engine 适配层 |
| **F · 尽力取消** | `cancelByRunId` + 响应 `cancelled: 'best-effort'` |
| **G · 配置统一** | `GLOBAL_API_PREFIX` 同时用于 HTTP 与 WS path |

---

## Run 状态机

```
queued → running → finished | failed
queued → rejected（DAG 校验失败，同步）
running → cancelled（尽力取消）
```

`RunRecord` 聚合：`runId`、`workflowSnapshot`、`status`、`counts`、`startedAt` / `finishedAt`、`result`、`events[]`、`traceId`。

---

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `GLOBAL_API_PREFIX` | **必填** | HTTP 全局前缀 + WS path |
| `PORT` | `3000` | 监听端口 |
| `MAX_PARALLEL_STEPS` | `1` | 步骤并行上限 |
| `RESOURCE_POOL_SIZE` | `5` | 默认资源池槽位数 |
| `MAX_ACTIVE_RUNS` | `50` | 活跃 Run 软上限 |
| `RUN_HISTORY_LIMIT` | `500` | Run 历史与单 Run 事件缓冲上限 |

---

## 验证情况

- [x] `pnpm run build` 通过
- [x] 本地启动成功，路由映射完整
- [x] `GET /healthz`、`GET /plugins`、`POST /runs`、`GET /runs` 手工验证通过
- [x] Run 生命周期事件（`workflow:start` → `step:*` → `workflow:finished`）写入 `events[]` 并可 REST 查询
- [ ] 单元测试 / e2e：Jest ESM 配置存在 `exports is not defined` 问题（改造前即有），待单独修复

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

1. 修复 Jest ESM 配置，恢复 e2e 自动化
2. 安装 `class-validator` 并补充 DTO
3. 按 [web-ui.md](../plans/web-ui.md) §10 做前后端联调验收

---

## 参考文档

- 设计方案：[docs/plans/server-api.md](../plans/server-api.md)
- 前端对照：[docs/plans/web-ui.md](../plans/web-ui.md) 附录 / §10
