# apps/server 接口清单

> 基于当前代码实现整理。所有 HTTP 路径均带全局前缀 `/{GLOBAL_API_PREFIX}`。  
> 下文路径与 Base URL 以当前本地 `.env` 为准：`GLOBAL_API_PREFIX=api/v1/devops`，`PORT=3000`。  
> 日常模板 `.env.example` 使用 `api`；`.env.test` / `pnpm dev:test` / Jest 亦为 `api/v1/devops`。

**最近更新**：2026-07-24

**Base URL**：`http://localhost:3000/api/v1/devops`

**已注册插件**（`apps/server/plugins.config.json` → `plugin-registry.ts`，运行 `pnpm sync:plugins` 同步）：

| 插件名               | 版本  | 说明                                 | configSchema | resultSchema |
| -------------------- | ----- | ------------------------------------ | ------------ | ------------ |
| `test-plugin`        | 1.0.0 | 测试插件（unit / integration / e2e） | 有           | 有           |
| `model-call-plugin`  | 1.0.0 | 调用 DeepSeek 模型                   | 有           | 有           |
| `muti-result-plugin` | 1.0.0 | 生成多层嵌套结果                     | 有           | 有           |
| `print-plugin`       | 1.0.0 | 向日志打印信息                       | 有           | 有           |

---

## 通用说明

### 错误响应格式

HTTP 异常统一由 `AllExceptionsFilter` 返回：

```json
{
  "statusCode": 400,
  "message": "错误描述",
  "error": "WorkflowValidationError",
  "code": "WORKFLOW_VALIDATION_ERROR",
  "details": {}
}
```

| 场景                       | HTTP  | error / code                                                            |
| -------------------------- | ----- | ----------------------------------------------------------------------- |
| DAG 校验失败               | `400` | `error: "WorkflowValidationError"`，`code: "WORKFLOW_VALIDATION_ERROR"` |
| 请求体 / 查询参数不合规    | `400` | ValidationPipe                                                          |
| dry-run 含上游 `$ref`      | `400` | 文案说明不支持引用                                                      |
| 活跃 Run 超限              | `429` | `code: "MAX_ACTIVE_RUNS_EXCEEDED"`                                      |
| 资源不存在                 | `404` | —                                                                       |
| 工作流名称或 ID 冲突       | `409` | 如「工作流名称「xxx」已存在」                                           |
| 删除进行中的 Run           | `409` | 「无法删除进行中的 Run」                                                |
| 公开工作流仍被引用时删除   | `409` | 附引用方工作流 id/名称列表                                              |
| 状态冲突（如非运行态暂停） | `409` | —                                                                       |
| 路径 id 与 body.id 不一致  | `400` | —                                                                       |
| `APP_ENV` 非法             | `500` | 首次读取 `GET /system/info` 时抛错                                      |

### 分页参数与响应

列表类接口通用 Query：

| 参数       | 类型   | 默认 | 说明                 |
| ---------- | ------ | ---- | -------------------- |
| `page`     | number | `1`  | 页码（从 1 开始）    |
| `pageSize` | number | `20` | 每页条数（最大 100） |
| `search`   | string | —    | 关键词搜索           |

分页响应统一结构：

```json
{
  "items": [],
  "total": 0,
  "page": 1,
  "pageSize": 20
}
```

### 事件缓冲与流式 log 合并

Run 的 `events[]` 与 WS 回放共享同一缓冲逻辑：

- 同一步骤、同一 `stream`（`stdout` / `stderr`）的连续 `plugin:log` 会**合并**为单条（message 拼接）
- 缓冲超限时**优先裁剪** `plugin:log`，尽量保留 `workflow:*` / `step:*` 生命周期事件（上限由 `RUN_HISTORY_LIMIT` 控制，默认 500）
- 内核事件按 `runId` **串行**写入缓冲后再扇出，避免并发乱序

---

## HTTP 接口

### 根路径 / 健康检查 / 系统信息

| 方法 | 路径           | 说明                    | 响应示例                                  |
| ---- | -------------- | ----------------------- | ----------------------------------------- |
| GET  | `/`            | 存活探测（Hello World） | `"Hello World!"`                          |
| GET  | `/healthz`     | 服务与 Engine 就绪状态  | `{ "status": "ok", "engineReady": true }` |
| GET  | `/system/info` | 系统信息（部署环境）    | 见下                                      |

**GET /system/info** 响应：

```json
{ "appEnv": "local-dev", "appEnvLabel": "本地开发" }
```

| 字段          | 说明                                                       |
| ------------- | ---------------------------------------------------------- |
| `appEnv`      | 部署环境码，来自环境变量 `APP_ENV`（未设默认 `local-dev`） |
| `appEnvLabel` | 对应中文标签                                               |

`APP_ENV` 合法值：`local-dev` / `online-dev` / `local-test` / `online-test` / `production`（标签分别为：本地开发 / 线上开发 / 本地测试 / 线上测试 / 生产）。

---

### Plugins · 插件

| 方法 | 路径                           | 说明                                                                |
| ---- | ------------------------------ | ------------------------------------------------------------------- |
| GET  | `/plugins`                     | 插件注册表列表                                                      |
| GET  | `/plugins/config-schemas`      | 全部插件 config JSON Schema                                         |
| GET  | `/plugins/result-schemas`      | 全部插件 result JSON Schema                                         |
| GET  | `/plugins/:name`               | 单个插件详情                                                        |
| GET  | `/plugins/:name/config-schema` | 单个插件 config 的 JSON Schema（Zod → JSON Schema，供前端表单渲染） |
| GET  | `/plugins/:name/result-schema` | 单个插件 result 的 JSON Schema                                      |
| POST | `/plugins/:name/dry-run`       | 单步试运行（**SSE 流式**）                                          |

**GET /plugins** 响应示例：

```json
[
  {
    "name": "test-plugin",
    "version": "1.0.0",
    "description": "这是一个测试插件",
    "hasConfigSchema": true,
    "hasResultSchema": true
  },
  {
    "name": "model-call-plugin",
    "version": "1.0.0",
    "description": "这是一个调用模型插件",
    "hasConfigSchema": true,
    "hasResultSchema": true
  },
  {
    "name": "muti-result-plugin",
    "version": "1.0.0",
    "description": "生成多层嵌套的结果插件",
    "hasConfigSchema": true,
    "hasResultSchema": true
  },
  {
    "name": "print-plugin",
    "version": "1.0.0",
    "description": "向日志打印信息插件",
    "hasConfigSchema": true,
    "hasResultSchema": true
  }
]
```

**GET /plugins/:name** 响应字段与列表项相同；插件不存在时返回 `404`。

**GET /plugins/config-schemas** 响应：`[{ "name": "...", "configJsonSchema": { ... } | null }, ...]`

**GET /plugins/result-schemas** 响应：`[{ "name": "...", "resultJsonSchema": { ... } | null }, ...]`

**GET /plugins/:name/config-schema** 响应示例（`test-plugin`）：

```json
{
  "name": "test-plugin",
  "configJsonSchema": {
    "type": "object",
    "properties": {
      "type": {
        "type": "string",
        "enum": ["unit", "integration", "e2e"]
      }
    },
    "required": ["type"],
    "additionalProperties": false
  }
}
```

插件不存在或未声明 `configSchema` 时返回 `404`（文案：`插件不存在或未声明 configSchema`）。

**GET /plugins/:name/result-schema** 响应：`{ "name": "...", "resultJsonSchema": { ... } }`  
插件不存在或未声明 `resultSchema` 时返回 `404`（文案：`插件不存在或未声明 resultSchema`）。

**POST /plugins/:name/dry-run** — SSE 流式响应

- Content-Type：`text/event-stream`
- 请求体：`{ "config": { ... } }`
- **不支持** config 中的上游步骤引用（`$ref`）；含引用时同步返回 `400`（非 SSE）
- 每条 SSE `data` 为 JSON，共三种消息类型：

| type    | 格式                                    | 说明                                                  |
| ------- | --------------------------------------- | ----------------------------------------------------- |
| `log`   | `{ "type": "log", "event": { ... } }`   | 试运行期间的 `plugin:log` 事件（已序列化）            |
| `done`  | `{ "type": "done", "result": { ... } }` | 步骤执行完成，`result` 为 `SerializedExecutionResult` |
| `error` | `{ "type": "error", "message": "..." }` | 试运行失败                                            |

`done.result` 字段说明：

| 字段                                   | 说明                      |
| -------------------------------------- | ------------------------- |
| `stepId`                               | 固定为 `"dry-run"`        |
| `status`                               | 步骤状态                  |
| `success`                              | 是否成功                  |
| `pluginResult`                         | 插件返回的 `PluginResult` |
| `error` / `failureKind` / `skipReason` | 失败或跳过时可选          |

流结束后连接关闭。插件不存在时仍返回 HTTP `404`（非 SSE）。

---

### Workflows · 工作流定义

| 方法   | 路径                        | 说明                                                                 |
| ------ | --------------------------- | -------------------------------------------------------------------- |
| GET    | `/step-kinds`               | 内置步骤形态清单（`BUILTIN_STEP_KIND_DEFINITIONS`）                  |
| GET    | `/workflows`                | 公开工作流列表（按 `updatedAt` 降序；过滤私有拷贝）                  |
| POST   | `/workflows`                | 创建工作流                                                            |
| POST   | `/workflows/validate`       | DAG / kind / 嵌套 / `$ref` 校验（不持久化）                          |
| GET    | `/workflows/:id`            | 工作流详情                                                           |
| PUT    | `/workflows/:id`            | 更新工作流                                                           |
| DELETE | `/workflows/:id`            | 删除工作流（公开且仍被引用 → `409`）                                 |
| POST   | `/workflows/:id/run`        | 触发已保存工作流运行                                                 |
| GET    | `/workflows/:id/imports`    | 已导入子工作流列表                                                   |
| POST   | `/workflows/:id/imports`    | 导入子工作流（`reference` / `copy`）                                 |

**GET /workflows** Query：`search`、`page`、`pageSize`。仅返回 `ownerWorkflowId IS NULL` 的公开工作流。

**WorkflowRecord** 响应结构（列表项 / 详情 / 创建 / 更新）：

| 字段         | 说明                            |
| ------------ | ------------------------------- |
| `id`         | 工作流 ID                       |
| `definition` | 规范化后的 `WorkflowDefinition`（可含 `stateSchema`、多 `kind` 步骤） |
| `createdAt`  | 创建时间                        |
| `updatedAt`  | 更新时间                        |

**POST /workflows** / **PUT /workflows/:id** 请求体（`WorkflowDraft`）：

`id` 与 `step.id` 可省略，由服务端生成 UUID。草稿编排阶段可用 `clientRef` 表达步骤间依赖（`dependsOn` 引用 `clientRef` 或已有 `step.id`）。步骤 `kind` 默认 `plugin`；`workflow` 步骤须引用本工作流已存在的 `importId`（建议顺序：先 create 父 → `POST .../imports` → 再 PUT 写入 workflow 步骤）。

```json
{
  "name": "示例工作流",
  "steps": [
    {
      "clientRef": "draft-a",
      "name": "步骤一",
      "plugin": "test-plugin",
      "config": { "type": "integration" },
      "dependsOn": []
    }
  ]
}
```

更新已保存工作流时，已有步骤携带 `id` 将保留；新增步骤省略 `id` 并可选 `clientRef`。

**POST /workflows** 冲突：`409`（名称重复或指定 id 已存在）。

**POST /workflows/validate** 响应：

```json
{ "valid": true }
```

校验失败时返回 `400` + `WorkflowValidationError`。

**POST /workflows/:id/imports** 请求体：

```json
{
  "childWorkflowId": "source-workflow-id",
  "mode": "reference",
  "stepId": "optional-hint"
}
```

- `mode: "reference"`：指向公开源工作流，实时解析最新定义
- `mode: "copy"`：新建私有 `Workflow`（`ownerWorkflowId` = 父 id，名称带 `__copy__` 后缀）+ 对应 `WorkflowImport`

**GET /workflows/:id/imports** 响应：导入记录列表（含 `importId`、`mode`、`childWorkflowId`、子工作流名称等）。

**GET /step-kinds** 响应：内置步骤定义数组（`kind` / `label` / `description` / `configSchema`）。

**POST /workflows/:id/run** 请求体（可选 Run 上下文）：

```json
{
  "priority": 0,
  "traceId": "trace-xxx",
  "failFast": true,
  "maxParallelSteps": 1,
  "initialState": { "count": 0 }
}
```

`initialState` 仅当目标工作流声明了 `stateSchema` 时允许，否则 `400`。

响应：

```json
{ "runId": "uuid", "status": "queued" }
```

---

### Runs · 运行实例（核心资源）

| 方法   | 路径                     | 说明                                          |
| ------ | ------------------------ | --------------------------------------------- |
| GET    | `/runs`                  | 运行历史列表（活跃 Run 置顶）                 |
| POST   | `/runs`                  | 内联 workflow 触发运行（未保存即运行）        |
| GET    | `/runs/:runId`           | Run 聚合详情                                  |
| GET    | `/runs/:runId/events`    | 事件缓冲回放（含子执行并入的嵌套事件）        |
| GET    | `/runs/:runId/children`  | 兼容路由；子执行不落独立行，恒 `{ children: [] }` |
| POST   | `/runs/:runId/cancel`    | 取消（`best-effort` / `hard`）                |
| POST   | `/runs/:runId/pause`     | 暂停                                          |
| POST   | `/runs/:runId/resume`    | 恢复                                          |
| DELETE | `/runs/:runId`           | 删除历史 Run（进行中的不可删）                |

**GET /runs** Query：

| 参数               | 说明                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `status`           | `queued` / `running` / `paused` / `pausing` / `finished` / `failed` / `rejected` / `cancelled` |
| `workflowId`       | 按工作流 ID 过滤                                                                               |
| `search`           | 搜索 runId / workflowId / workflow 名称                                                        |
| `page`、`pageSize` | 分页                                                                                           |

排序规则：活跃状态（含 `queued` / `running` / `pausing` / `paused`）优先，同组内按 `createdAt` 降序。

**POST /runs** 请求体：

```json
{
  "workflow": { "id": "...", "name": "...", "steps": [...] },
  "priority": 0,
  "traceId": "trace-xxx",
  "failFast": true,
  "maxParallelSteps": 1
}
```

`workflow` 为必填；省略 `traceId` 时服务端自动生成。`workflow` 亦接受 `WorkflowDraft` 格式。可选字段：`priority`、`traceId`、`failFast`、`maxParallelSteps`、`initialState`（须声明 `stateSchema`）。

**GET /runs/:runId** 响应字段：

| 字段                                     | 说明                                           |
| ---------------------------------------- | ---------------------------------------------- |
| `runId`                                  | Run 标识                                       |
| `workflowId`                             | 工作流 ID                                      |
| `workflowSnapshot`                       | 提交时的 workflow 快照                         |
| `status`                                 | 运行状态                                       |
| `traceId`                                | 链路追踪 ID                                    |
| `counts`                                 | `{ total, completed, failed, skipped }`        |
| `createdAt` / `startedAt` / `finishedAt` | 时间戳                                         |
| `result`                                 | 终态运行结果（序列化后的 `WorkflowRunResult`） |
| `events`                                 | 已缓冲的生命周期事件数组（含合并后的流式 log） |
| `cancelled`                              | 取消时为 `"best-effort"` 或 `"hard"`           |

**GET /runs/:runId/events** 响应：

```json
{
  "runId": "uuid",
  "events": []
}
```

**POST /runs/:runId/cancel** 请求体（可选）：

```json
{ "mode": "best-effort" }
```

`mode`：`best-effort`（默认）\| `hard`。

已终态（`finished` / `failed` / `rejected`）时返回当前状态，`cancelled` 为 `undefined`：

```json
{ "runId": "uuid", "status": "finished" }
```

可取消时：

```json
{ "runId": "uuid", "status": "cancelled", "cancelled": "best-effort" }
```

**POST /runs/:runId/pause** 请求体（可选）：

```json
{ "waitInFlight": true, "abortInFlight": false }
```

**POST /runs/:runId/resume**：无请求体。状态不允许时返回 `409`。

**DELETE /runs/:runId** 响应：

```json
{ "runId": "uuid", "deleted": true }
```

进行中状态返回 `409`；不存在返回 `404`。

---

### Resources · 资源与队列

| 方法 | 路径               | 说明             |
| ---- | ------------------ | ---------------- |
| GET  | `/resources`       | 资源池快照       |
| GET  | `/resources/queue` | 资源调度队列状态 |

**GET /resources** 响应示例：

```json
[{ "id": "default-0", "type": "default", "name": "default-slot-0", "status": "available" }]
```

**GET /resources/queue** 响应示例：

```json
{
  "byType": {
    "default": { "queueLength": 0, "runningCount": 1 }
  }
}
```

---

### Stats · 统计

| 方法 | 路径              | 说明         |
| ---- | ----------------- | ------------ |
| GET  | `/stats/overview` | 实时聚合概览 |

响应示例：

```json
{
  "activeRuns": 0,
  "finishedRuns": 5,
  "failedRuns": 1,
  "successRate": 0.833,
  "pluginCount": 4,
  "queue": { "byType": { "default": { "queueLength": 0, "runningCount": 0 } } }
}
```

`successRate`：有终态 Run（`finished` + `failed` > 0）时为 `finished / (finished + failed)`，否则为 `null`。

---

### Test DevOps · 兼容验证

| 方法 | 路径           | 说明                                                                       |
| ---- | -------------- | -------------------------------------------------------------------------- |
| GET  | `/test-devops` | 同步跑内置 integration workflow（engine 直跑，不经 RunManager 持久化列表） |

响应示例：

```json
{
  "success": true,
  "message": "集成测试执行成功",
  "workflowId": "integration-closed-loop"
}
```

---

## WebSocket 接口

出站消息**均附带 `runId`**（`error` 可选），便于单连接订阅多个 Run。

### 主通道 · `/runs/ws`

**连接地址**：`ws://localhost:3000/api/v1/devops/runs/ws`

#### 入站消息

| type          | 格式                                                            | 说明                                                                      |
| ------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `subscribe`   | `{ "type": "subscribe", "runId": "uuid", "fromEventIndex": 0 }` | 订阅指定 Run；先回放已有事件，再接实时流。`fromEventIndex` 可选，默认 `0` |
| `unsubscribe` | `{ "type": "unsubscribe", "runId": "uuid" }`                    | 取消订阅                                                                  |
| `run`         | `{ "type": "run", "workflow": { ... } }`                        | 受理 Run 并自动订阅                                                       |

#### 出站消息

| type    | 格式                                                      | 说明                              |
| ------- | --------------------------------------------------------- | --------------------------------- |
| `event` | `{ "type": "event", "runId": "uuid", "event": { ... } }`  | 生命周期事件（已序列化）          |
| `done`  | `{ "type": "done", "runId": "uuid", "result": { ... } }`  | Run 完成                          |
| `error` | `{ "type": "error", "runId"?: "uuid", "message": "..." }` | 错误（协议/订阅错误可能无 runId） |

**生命周期事件类型**：`workflow:start`、`workflow:finished`、`step:queued`、`step:start`、`step:finished`、`plugin:log`

`plugin:log` 可含 `log.stream`（`stdout` / `stderr`）用于流式输出；缓冲中同 stream 连续 log 已合并。

连接断开仅退订，Run 继续执行。订阅时若 Run 已终态，会立即推送 `done`。

---

### 兼容通道 · `/test-devops/ws`

**连接地址**：`ws://localhost:3000/api/v1/devops/test-devops/ws`

#### 入站消息

| type  | 格式                                     | 说明                                       |
| ----- | ---------------------------------------- | ------------------------------------------ |
| `run` | `{ "type": "run", "workflow": { ... } }` | 向后兼容旧协议；内部 = 受理 Run + 自动订阅 |

#### 出站消息

与 `/runs/ws` 相同（`event` / `done` / `error`，均含 `runId`）。

---

## 接口总览（速查）

| #   | 方法   | 路径                           | 分组        |
| --- | ------ | ------------------------------ | ----------- |
| 1   | GET    | `/`                            | 根          |
| 2   | GET    | `/healthz`                     | 健康        |
| 3   | GET    | `/system/info`                 | 系统        |
| 4   | GET    | `/plugins`                     | 插件        |
| 5   | GET    | `/plugins/config-schemas`      | 插件        |
| 6   | GET    | `/plugins/result-schemas`      | 插件        |
| 7   | GET    | `/plugins/:name`               | 插件        |
| 8   | GET    | `/plugins/:name/config-schema` | 插件        |
| 9   | GET    | `/plugins/:name/result-schema` | 插件        |
| 10  | POST   | `/plugins/:name/dry-run`       | 插件（SSE） |
| 11  | GET    | `/step-kinds`                  | 工作流      |
| 12  | GET    | `/workflows`                   | 工作流      |
| 13  | POST   | `/workflows`                   | 工作流      |
| 14  | POST   | `/workflows/validate`          | 工作流      |
| 15  | GET    | `/workflows/:id`               | 工作流      |
| 16  | PUT    | `/workflows/:id`               | 工作流      |
| 17  | DELETE | `/workflows/:id`               | 工作流      |
| 18  | POST   | `/workflows/:id/run`           | 工作流      |
| 19  | GET    | `/workflows/:id/imports`       | 工作流      |
| 20  | POST   | `/workflows/:id/imports`       | 工作流      |
| 21  | GET    | `/runs`                        | 运行        |
| 22  | POST   | `/runs`                        | 运行        |
| 23  | GET    | `/runs/:runId`                 | 运行        |
| 24  | GET    | `/runs/:runId/events`          | 运行        |
| 25  | GET    | `/runs/:runId/children`        | 运行        |
| 26  | POST   | `/runs/:runId/cancel`          | 运行        |
| 27  | POST   | `/runs/:runId/pause`           | 运行        |
| 28  | POST   | `/runs/:runId/resume`          | 运行        |
| 29  | DELETE | `/runs/:runId`                 | 运行        |
| 30  | GET    | `/resources`                   | 资源        |
| 31  | GET    | `/resources/queue`             | 资源        |
| 32  | GET    | `/stats/overview`              | 统计        |
| 33  | GET    | `/test-devops`                 | 兼容        |
| 34  | WS     | `/runs/ws`                     | WebSocket   |
| 35  | WS     | `/test-devops/ws`              | WebSocket   |

---

## 相关文档

- Server README：[apps/server/README.md](../../apps/server/README.md)
- 设计方案：[docs/plans/server-api.md](../plans/server-api.md)
- 开发日志：[docs/dev-logs/server.md](./server.md)
