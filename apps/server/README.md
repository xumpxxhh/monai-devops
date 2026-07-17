# Server（apps/server）

`apps/server` 是 `monai-devops` 的后端服务，基于 NestJS，负责：

- 注册并管理插件（Plugin）
- 管理工作流（Workflow）定义
- 提交/查询/控制运行实例（Run）
- 通过 HTTP + WebSocket/SSE 提供实时状态与日志
- 暴露资源与统计信息，便于前端或外部系统接入

---

## 1. 功能概览

### 核心能力

- **工作流管理**：创建、更新、校验、删除、触发执行。
- **运行管理**：提交运行、查询详情、事件回放、暂停/恢复/取消、删除历史。
- **插件能力**：查看插件元数据、导出插件配置 schema、插件 dry-run（SSE 流式返回日志）。
- **实时通道**：
  - `runs` WebSocket：订阅单个 run 的事件流。
  - `test-devops` WebSocket：直接通过消息执行 workflow 并自动订阅结果。
- **观测能力**：健康检查、运行统计、资源队列状态。

### 当前实现特性（重要）

- **存储层为内存实现**（非持久化）：
  - workflow 使用 `InMemoryWorkflowRepository`
  - run 使用 `InMemoryRunRepository`
- 服务重启后，内存数据会丢失。
- 默认内置一个初始 workflow（`new-workflow`），便于快速联调。

---

## 2. 项目结构（apps/server）

```txt
src/
  engine/          # core-engine 封装与生命周期管理
  workflows/       # 工作流 CRUD + 触发运行
  runs/            # 运行状态机、事件流、WebSocket
  plugins/         # 插件信息、配置 schema、dry-run
  resources/       # 资源与队列状态
  stats/           # 聚合统计
  health/          # 健康检查
  test-devops/     # DevOps 联调入口（HTTP + WS）
  common/          # 通用校验、序列化、异常过滤器
```

---

## 3. 前置要求

- Node.js `>= 20`
- pnpm（仓库根目录 `packageManager` 当前为 `pnpm@10.18.2`）

在仓库根目录安装依赖：

```bash
pnpm install
```

---

## 4. 环境变量

服务会按顺序加载 `.env.local`、`.env`（若环境变量已存在则不覆盖）。

> `GLOBAL_API_PREFIX` 是**必填项**，未配置会在启动时直接退出。

| 变量名 | 是否必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `GLOBAL_API_PREFIX` | 是 | 无 | 全局 API 前缀，例如 `api`。影响 HTTP、WS 路径。 |
| `PORT` | 否 | `3000` | HTTP 服务端口。 |
| `MAX_PARALLEL_STEPS` | 否 | `2` | 引擎内单个 workflow 的默认并行步数上限。 |
| `RESOURCE_POOL_SIZE` | 否 | `5` | 引擎默认资源池容量。 |
| `MAX_ACTIVE_RUNS` | 否 | `50` | 活跃 run 上限（超过返回 429）。 |
| `RUN_HISTORY_LIMIT` | 否 | `500` | Run 事件历史与内存回收相关上限。 |

示例（`apps/server/.env.local`）：

```env
GLOBAL_API_PREFIX=api
PORT=3000
MAX_PARALLEL_STEPS=2
RESOURCE_POOL_SIZE=5
MAX_ACTIVE_RUNS=50
RUN_HISTORY_LIMIT=500
```

---

## 5. 启动与构建

建议在仓库根目录执行（Turbo 会按 workspace 过滤）：

```bash
# 仅启动 server（开发模式）
pnpm dev:server
```

也可在 `apps/server` 目录直接执行：

```bash
# 开发热更新
pnpm dev

# 生产编译
pnpm build

# 生产启动
pnpm start:prod
```

---

## 6. 插件注册机制

- `src/plugins/plugin-registry.ts` 为**自动生成文件**，由根脚本同步：
  - 根目录执行：`pnpm sync:plugins`
- `apps/server/package.json` 中 `prebuild` 会自动触发同步脚本。
- 当前 `plugins.config.json` 中启用：
  - `test-plugin`
  - `model-call-plugin`

如新增/删除插件，请先更新插件配置并执行同步，再启动服务。

---

## 7. API 一览

以下示例默认：

- `GLOBAL_API_PREFIX=api`
- 服务地址为 `http://localhost:3000`

即基础前缀为：`/api`

### 7.1 健康与基础

- `GET /api/healthz`：健康检查（包含 `engineReady`）
- `GET /api/`：基础探活（返回 `Hello World!`）

### 7.2 Workflows

- `GET /api/workflows?search=&page=1&pageSize=20`
- `POST /api/workflows`
- `POST /api/workflows/validate`
- `GET /api/workflows/:id`
- `PUT /api/workflows/:id`
- `DELETE /api/workflows/:id`
- `POST /api/workflows/:id/run`（触发运行）

创建 workflow 示例：

```bash
curl -X POST "http://localhost:3000/api/workflows" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "demo-workflow",
    "name": "Demo Workflow",
    "steps": [
      {
        "id": "step-1",
        "name": "Run Unit Test",
        "plugin": "test-plugin",
        "config": { "type": "unit" }
      }
    ]
  }'
```

### 7.3 Runs

- `GET /api/runs?status=&workflowId=&search=&page=1&pageSize=20`
- `POST /api/runs`（内联 workflow 提交）
- `GET /api/runs/:runId`
- `GET /api/runs/:runId/events`
- `POST /api/runs/:runId/cancel`（`{ "mode": "best-effort" | "hard" }`）
- `POST /api/runs/:runId/pause`（`{ "waitInFlight": true, "abortInFlight": false }`）
- `POST /api/runs/:runId/resume`
- `DELETE /api/runs/:runId`（仅允许删除终态 run）

内联提交 run 示例：

```bash
curl -X POST "http://localhost:3000/api/runs" \
  -H "Content-Type: application/json" \
  -d '{
    "workflow": {
      "id": "inline-workflow",
      "name": "Inline Workflow",
      "steps": [
        {
          "id": "inline-step",
          "name": "Inline Step",
          "plugin": "test-plugin",
          "config": { "type": "integration" }
        }
      ]
    },
    "priority": 1,
    "traceId": "trace-demo-001"
  }'
```

### 7.4 Plugins

- `GET /api/plugins`
- `GET /api/plugins/config-schemas`
- `GET /api/plugins/:name/config-schema`
- `GET /api/plugins/result-schemas`
- `GET /api/plugins/:name/result-schema`
- `GET /api/plugins/:name`
- `POST /api/plugins/:name/dry-run`（SSE）

`GET /api/plugins` / `GET /api/plugins/:name` 响应含 `hasResultSchema`（是否声明了 `resultSchema`）。

`GET /api/plugins/:name/result-schema`：无插件或未声明 `resultSchema` 时返回 404（文案：`插件不存在或未声明 resultSchema`）。

插件 dry-run（SSE）示例：

```bash
curl -N -X POST "http://localhost:3000/api/plugins/test-plugin/dry-run" \
  -H "Content-Type: application/json" \
  -d '{ "config": { "type": "unit" } }'
```

SSE 事件数据类型：

- `log`：插件日志事件
- `done`：执行完成结果
- `error`：执行失败信息

> dry-run **不支持** config 中的上游步骤引用（`$ref`）；含引用时同步返回 400。完整工作流运行会由 core-engine 解析引用。

### 7.5 Resources / Stats / Test-DevOps

- `GET /api/resources`：资源列表
- `GET /api/resources/queue`：资源等待队列
- `GET /api/stats/overview`：聚合统计（活跃/完成/失败/successRate/pluginCount/queue）
- `GET /api/test-devops`：运行集成测试 workflow（HTTP 触发）

---

## 8. WebSocket 协议

### 8.1 Runs WS

- 路径：`ws://localhost:3000/api/runs/ws`

客户端可发送：

- `{"type":"subscribe","runId":"<run-id>"}`
- `{"type":"unsubscribe","runId":"<run-id>"}`
- `{"type":"run","workflow":{...}}`

服务端消息：

- `event`：`{ type, runId, event }`
- `done`：`{ type, runId, result }`
- `error`：`{ type, runId?, message }`

### 8.2 Test-DevOps WS

- 路径：`ws://localhost:3000/api/test-devops/ws`
- 客户端发送：`{"type":"run","workflow":{...}}`
- 服务端回放/推送 run 事件与完成结果（同 `runs` 流格式）

---

## 9. 错误处理约定

全局使用 `AllExceptionsFilter` 统一错误返回格式：

```json
{
  "statusCode": 400,
  "message": "错误描述",
  "error": "ErrorName",
  "code": "OPTIONAL_CODE",
  "details": {}
}
```

典型场景：

- Workflow 校验失败：`400` + `WORKFLOW_VALIDATION_ERROR`
- 活跃 run 达上限：`429` + `MAX_ACTIVE_RUNS_EXCEEDED`
- 资源不存在：`404`
- 状态冲突（如非运行态暂停）：`409`

---

## 10. 测试命令

在 `apps/server` 目录：

```bash
# 单测
pnpm test

# e2e
pnpm test:e2e

# 覆盖率
pnpm test:cov

# 插件测试
pnpm test:plugins
```

---

## 11. 已知限制与后续建议

- 当前仓储层为内存实现，不适合生产数据保留场景。
- 可优先将 `WorkflowRepository` / `RunRepository` 抽象对接持久化存储（如 PostgreSQL / Redis）。
- 若接入生产环境，建议补充：
  - 鉴权与权限控制
  - API 限流策略
  - 可观测性（日志、指标、链路追踪）
