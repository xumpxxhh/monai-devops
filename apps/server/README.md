# apps/server

NestJS HTTP / WebSocket 服务：把 `@monai-devops/core-engine` 接到 PostgreSQL 持久化、REST API 与实时事件推流，并托管工作流 CRUD、插件元数据与试运行。

本应用是 monai-devops 的后端入口；前端与其它客户端通过全局前缀（如 `/api`）访问。

## 职责边界

| 层 | 职责 |
|---|---|
| **HTTP / WS** | 校验入参、鉴权占位（当前无登录）、返回序列化 DTO |
| **RunManager** | 受理 Run、落库、订阅引擎事件、推流、取消/暂停/恢复 |
| **WorkflowsService** | 工作流持久化、导入（reference/copy）、触发运行、校验 |
| **EngineService** | 进程内唯一 `createEngine` 实例；插件注册、资源池、观察者扇出 |
| **Prisma** | `Workflow` / `WorkflowImport` / `Run` / `RunEvent` |

引擎负责 DAG 执行与资源调度；server **不重写编排逻辑**，只做：校验 → 落表 → 调引擎 → 事件持久化与推流。

## 技术栈

- NestJS 11 + Express + `WsAdapter`（原生 `ws`）
- Prisma 6 + PostgreSQL
- `@monai-devops/core-engine` / `@monai-devops/plugin-sdk`
- 工作区插件（由 `plugins.config.json` + `sync-plugin-registry` 生成注册表）
- `class-validator` / `class-transformer`（全局 `ValidationPipe`）
- `zod-to-json-schema`（插件 schema 暴露给前端）

## 快速开始

### 前置

1. Node.js `>= 20`，仓库根目录已 `pnpm install`
2. PostgreSQL 可用（本地可用仓库根目录 docker compose，默认用户/库见 `.env.example`）
3. 在 `apps/server` 复制环境文件：

```bash
# 日常开发
cp .env.example .env
# 按需改 DATABASE_URL / GLOBAL_API_PREFIX 等
```

### 数据库

```bash
cd apps/server
pnpm db:generate
pnpm db:migrate:dev    # 开发库迁移
# 或 pnpm db:migrate   # deploy（CI / 固定环境）
```

测试库（`*.env.test` → `monai_devops_test`）：

```bash
pnpm db:migrate:test
```

### 启动

```bash
# 仓库根
pnpm dev:server

# 或在 apps/server
pnpm dev                 # 读 .env.local / .env
pnpm dev:test            # 强制用 .env.test（MONAI_ENV_FILE）
```

默认监听 `PORT`（3000）。启动时 **必须** 设置 `GLOBAL_API_PREFIX`，否则进程退出。所有 HTTP / WS 路径都挂在该前缀下，例如前缀 `api` 时：

- HTTP：`http://localhost:3000/api/...`
- Run WS：`ws://localhost:3000/api/runs/ws`

健康检查：`GET /{prefix}/healthz`

---

## 架构一览

```
Client (web / curl / WS)
        │
        ▼
 Nest Controllers / RunsGateway
        │
        ├── WorkflowsService ──► WorkflowRepository (Prisma)
        ├── RunManagerService ──► RunRepository (Prisma)
        │         │                    ▲
        │         │  onEvent（串行链）   │ appendEvent / update
        │         ▼                    │
        └── EngineService ── createEngine (core-engine)
                  │
                  ├── registeredPlugins（自动生成）
                  ├── resolveWorkflow(importId) ← WorkflowsService 注入
                  └── embeddedRunHooks ← RunManager 注入
```

要点：

- **引擎事件不阻塞调度**：`RunManager` 用 per-run 的 `eventChains` 异步落库；`onEvent` 不向引擎回传 Promise。
- **嵌套子 run 不落独立 `Run` 行**：`childRunId → rootRunId` 映射后，子事件写入并推流到顶层 run；可观测性靠事件里的 `parent` / `workflow:iteration:*`。
- **`GET /runs/:runId/children` 恒返回空数组**（兼容旧路由）。

---

## 模块与目录

```
apps/server/
├── src/
│   ├── main.ts / preload-env.ts / app.module.ts
│   ├── engine/           # EngineService（全局）
│   ├── workflows/        # CRUD、导入、触发运行
│   ├── runs/             # Run 受理、控制、WS Gateway、Prisma 仓储
│   ├── plugins/          # 列表 / JSON Schema / SSE dry-run
│   ├── resources/        # 引擎资源池与等待队列只读视图
│   ├── stats/            # 概览指标
│   ├── health/           # healthz
│   ├── system/           # APP_ENV 信息
│   ├── test-devops/      # 内置集成探测（开发用）
│   ├── prisma/           # PrismaService
│   └── common/           # 校验、序列化、分页、异常过滤、DB URL 断言
├── prisma/schema.prisma
├── plugins.config.json   # 启用哪些工作区插件
├── .env.example / .env.test
└── test/                 # e2e / jest setup
```

`src/plugins/plugin-registry.ts` 为 **自动生成文件**，勿手改。变更启用列表后：

```bash
# 仓库根
pnpm sync:plugins
# 或任意次 pnpm build（prebuild 会跑 sync）
```

---

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `GLOBAL_API_PREFIX` | ✅ | — | HTTP/WS 全局前缀（如 `api` 或 `api/v1/devops`） |
| `DATABASE_URL` | ✅（非 test） | — | PostgreSQL 连接串 |
| `APP_ENV` | | `local-dev` | `local-dev` \| `online-dev` \| `local-test` \| `online-test` \| `production` |
| `PORT` | | `3000` | 监听端口 |
| `MAX_PARALLEL_STEPS` | | `2` | 单个 workflow 内默认并行步骤上限 |
| `RESOURCE_POOL_SIZE` | | `5` | 引擎 `default` 资源池槽位数 |
| `MAX_NESTING_DEPTH` | | `3` | 子工作流嵌套深度上限 |
| `MAX_ACTIVE_RUNS` | | `50` | 活跃 Run 上限（queued/running/pausing/paused）；超出 `429` |
| `RUN_HISTORY_LIMIT` | | `500` | 单 Run 事件条数上限（超限优先裁剪 `plugin:log`） |
| `MONAI_ENV_FILE` | | — | 指定 env 文件并 **覆盖** 其中键（`dev:test` 使用） |

加载顺序（`preload-env`）：

1. 若设了 `MONAI_ENV_FILE` → 只加载该文件（`override: true`）
2. 否则 → `.env.local` → `.env`（不覆盖已有 `process.env`）

`ConfigModule` 仍会再读 `.env.local` / `.env`；**日常开发连 `monai_devops`，测试用 `.env.test` / `pnpm dev:test`，不要靠手改 `.env` 切库。**

---

## 数据模型（Prisma）

| 表 | 作用 |
|---|---|
| `workflows` | 工作流定义 JSON；`owner_workflow_id` 非空表示 **私有拷贝**（不进公开列表） |
| `workflow_imports` | 父工作流导入子工作流：`mode` = `reference` \| `copy`，`id` 即步骤里的 `importId` |
| `runs` | 一次顶层执行：快照、状态、计数、结果、可选 `parent_run_id` |
| `run_events` | 事件流（`run_id` + `event_index` 唯一） |

Run 状态：`queued` → `running` / `pausing` / `paused` → `finished` \| `failed` \| `cancelled`；校验失败可为 `rejected`。进行中的 Run 不可删除。

---

## HTTP API

以下路径均相对于 `/{GLOBAL_API_PREFIX}`。分页默认 `page=1`、`pageSize=20`（最大 100）。

### 系统 / 健康

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/` | 占位 hello |
| `GET` | `/healthz` | `{ status, engineReady }` |
| `GET` | `/system/info` | `{ appEnv, appEnvLabel }` |
| `GET` | `/stats/overview` | 活跃/成功/失败 Run、插件数、资源队列 |
| `GET` | `/test-devops` | 内置集成探测 |

### 工作流

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/step-kinds` | 内置步骤形态（`set_state` / `workflow` 等） |
| `GET` | `/workflows` | 列表（默认仅公开；`search` / 分页） |
| `POST` | `/workflows` | 创建（自动补全缺失 id） |
| `POST` | `/workflows/validate` | 只校验不落库 |
| `GET` | `/workflows/:id` | 详情 |
| `PUT` | `/workflows/:id` | 更新（同步 import 的 `stepId`） |
| `DELETE` | `/workflows/:id` | 删除；仍被引用则 `409 WORKFLOW_STILL_REFERENCED` |
| `POST` | `/workflows/:id/run` | 用已存定义触发 Run |
| `GET` | `/workflows/:id/imports` | 导入列表 |
| `POST` | `/workflows/:id/imports` | 创建导入：`{ childWorkflowId, mode, stepId? }` |

导入规则摘要：

- `reference`：步骤通过 `importId` 指向已有公开工作流
- `copy`：复制一份私有子工作流（`ownerWorkflowId = 父 id`），再建立 import
- 不可导入私有拷贝、不可导入自身；同一来源重复导入会 `400`

保存/更新时会跑完整校验：基础字段、步骤名唯一、DAG、`$ref`、step kinds、嵌套深度、以及（有 imports 时）`importId` 必须落在本工作流导入记录中。

### Run

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/runs` | 列表（`status` / `workflowId` / `search` / 分页） |
| `POST` | `/runs` | body 带完整 `workflow` 草稿直接受理 |
| `GET` | `/runs/:runId` | 详情（合并引擎侧 live 控制态） |
| `GET` | `/runs/:runId/events` | 已持久化事件 |
| `GET` | `/runs/:runId/children` | 兼容接口，恒 `{ children: [] }` |
| `POST` | `/runs/:runId/cancel` | `{ mode?: 'best-effort' \| 'hard' }` |
| `POST` | `/runs/:runId/pause` | `{ waitInFlight?, abortInFlight? }` |
| `POST` | `/runs/:runId/resume` | 恢复 |
| `DELETE` | `/runs/:runId` | 仅终态可删 |

`POST /runs` / `POST /workflows/:id/run` 可选字段：`priority`、`traceId`、`initialState` 等。活跃数达 `MAX_ACTIVE_RUNS` 时返回 `429` + `MAX_ACTIVE_RUNS_EXCEEDED`。

受理成功立即返回 `{ runId, status: 'queued' }`，执行在后台进行。

### 插件

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/plugins` | 已注册插件摘要 |
| `GET` | `/plugins/config-schemas` | 全部 config JSON Schema |
| `GET` | `/plugins/result-schemas` | 全部 result JSON Schema |
| `GET` | `/plugins/:name` | 单个插件 |
| `GET` | `/plugins/:name/config-schema` | |
| `GET` | `/plugins/:name/result-schema` | |
| `POST` | `/plugins/:name/dry-run` | **SSE**：试运行单插件（config 中禁止 `$ref`） |

SSE 消息形态：`{ type: 'log', event }` / `{ type: 'done', result }` / `{ type: 'error', message }`。

### 资源

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/resources` | 当前资源槽位列表 |
| `GET` | `/resources/queue` | 按 type 的等待队列状态 |

---

## WebSocket：Run 事件流

- 路径：`/{GLOBAL_API_PREFIX}/runs/ws`
- 适配器：`@nestjs/platform-ws`（非 Socket.IO）

### 客户端 → 服务端

```json
{ "type": "subscribe", "runId": "<id>", "fromEventIndex": 0 }
{ "type": "unsubscribe", "runId": "<id>" }
{ "type": "run", "workflow": { /* WorkflowDefinition 草稿 */ } }
```

`run`：内部 `submitRun` 后自动 `subscribe` 该 run。

### 服务端 → 客户端

```json
{ "type": "event", "runId": "...", "event": { /* 序列化生命周期事件 */ } }
{ "type": "done", "runId": "...", "result": { /* WorkflowRunResult */ } }
{ "type": "error", "runId?": "...", "message": "..." }
```

订阅时会从 `fromEventIndex` 回放已存事件；若 Run 已终态且有 `result`，会再发一条 `done`。

---

## 错误与校验

全局 `AllExceptionsFilter`：

- `WorkflowValidationError` → `400`，`code: WORKFLOW_VALIDATION_ERROR`
- `HttpException` → 原状态码；可带业务 `code`（如 `WORKFLOW_STILL_REFERENCED`、`MAX_ACTIVE_RUNS_EXCEEDED`）
- 其它 `Error` → `500`

全局 `ValidationPipe`：`whitelist` + `forbidNonWhitelisted` + `transform`。

---

## 插件接入

1. 在 `plugins/` 下实现插件包（依赖 `plugin-sdk`）
2. 把包名写入 `apps/server/plugins.config.json` 的 `plugins` 数组
3. 确保 `apps/server/package.json` 有对应 `workspace:*` 依赖
4. 运行 `pnpm sync:plugins`（或任意 `build`），更新 `plugin-registry.ts`
5. 重启 server；`EngineService` 启动时 `createEngine({ plugins: registeredPlugins })`

当前默认启用：`test-plugin`、`model-call-plugin`、`muti-result-plugin`、`print-plugin`、`embedding-plugin`。

---

## 脚本

| 脚本 | 作用 |
|---|---|
| `pnpm dev` | `nest start --watch` |
| `pnpm dev:test` | 使用 `.env.test` 启动 |
| `pnpm build` | 先 sync 插件注册表，再 `nest build` |
| `pnpm start:prod` | `node dist/src/main` |
| `pnpm test` / `test:e2e` | Jest 单元 / e2e |
| `pnpm check-types` | `tsc --noEmit` |
| `pnpm lint` / `format` | ESLint / Prettier |
| `pnpm db:generate` | Prisma Client |
| `pnpm db:migrate` / `db:migrate:dev` | 迁移 |
| `pnpm db:migrate:test` | 测试库迁移 |
| `pnpm db:studio` | Prisma Studio |

---

## 设计备忘

- **一份进程一个引擎**：`EngineModule` 全局；销毁时 `engine.destroy()`。
- **工作流 id 规范化**：草稿可缺 id；`normalizeWorkflowIds` 在保存/提交前补齐，并尽量保留已有 step id。
- **事件序列化**：引擎事件经 `serialize-workflow-event` 去掉不可 JSON 化字段后再入库与推流；流式 `plugin:log` 可合并（见 `merge-stream-log-event`）。
- **查询详情时**：DB 记录与 `engine.getRunStatus` 合并，以便看到 `cancelling` / `pausing` 等瞬时态。
- **无认证**：当前所有接口开放；生产前需自行加网关或守卫。
