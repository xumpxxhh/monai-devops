# apps/server 接口清单

> 基于当前代码实现整理。所有 HTTP 路径均带全局前缀 `/{GLOBAL_API_PREFIX}`。  
> 当前默认配置（`.env`）：`GLOBAL_API_PREFIX=api/v1/devops`，`PORT=3000`。

**Base URL**：`http://localhost:3000/api/v1/devops`

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

- DAG 校验失败：`400`，`error: "WorkflowValidationError"`
- 活跃 Run 超限：`429`，`code: "MAX_ACTIVE_RUNS_EXCEEDED"`
- 资源不存在：`404`

### 分页参数

列表类接口通用 Query：

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `page` | number | `1` | 页码（从 1 开始） |
| `pageSize` | number | `20` | 每页条数（最大 100） |
| `search` | string | — | 关键词搜索 |

---

## HTTP 接口

### 根路径 / 健康检查

| 方法 | 路径 | 说明 | 响应示例 |
| --- | --- | --- | --- |
| GET | `/` | 存活探测（Hello World） | `"Hello World!"` |
| GET | `/healthz` | 服务与 Engine 就绪状态 | `{ "status": "ok", "engineReady": true }` |

---

### Plugins · 插件

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/plugins` | 插件注册表列表 |
| GET | `/plugins/:name` | 单个插件详情 |
| POST | `/plugins/:name/dry-run` | 单步试运行 |

**GET /plugins** 响应示例：

```json
[
  { "name": "test-plugin", "version": "1.0.0", "description": "..." }
]
```

**POST /plugins/:name/dry-run** 请求体：

```json
{ "config": { "type": "integration" } }
```

响应为 `ExecutionResult`（步骤执行结果，含 `stepId`、`status`、`success`、`pluginResult` 等）。

---

### Workflows · 工作流定义

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/workflows` | 工作流列表 |
| POST | `/workflows` | 创建工作流 |
| POST | `/workflows/validate` | DAG 校验（不持久化） |
| GET | `/workflows/:id` | 工作流详情 |
| PUT | `/workflows/:id` | 更新工作流 |
| DELETE | `/workflows/:id` | 删除工作流 |
| POST | `/workflows/:id/run` | 触发已保存工作流运行 |

**GET /workflows** Query：`search`、`page`、`pageSize`

**POST /workflows** / **PUT /workflows/:id** 请求体（`WorkflowDraft`）：

`id` 与 `step.id` 可省略，由服务端生成 UUID。草稿编排阶段可用 `clientRef` 表达步骤间依赖（`dependsOn` 引用 `clientRef` 或已有 `step.id`）。

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

**POST /workflows/validate** 响应：

```json
{ "valid": true }
```

校验失败时返回 `400` + `WorkflowValidationError`。

**POST /workflows/:id/run** 请求体（可选 Run 上下文）：

```json
{
  "priority": 0,
  "traceId": "trace-xxx",
  "failFast": true,
  "maxParallelSteps": 1
}
```

响应：

```json
{ "runId": "uuid", "status": "queued" }
```

---

### Runs · 运行实例（核心资源）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/runs` | 运行历史列表（活跃 Run 置顶） |
| POST | `/runs` | 内联 workflow 触发运行（未保存即运行） |
| GET | `/runs/:runId` | Run 聚合详情 |
| GET | `/runs/:runId/events` | 事件缓冲回放 |
| POST | `/runs/:runId/cancel` | 尽力取消 |
| DELETE | `/runs/:runId` | 删除历史 Run（进行中的不可删） |

**GET /runs** Query：

| 参数 | 说明 |
| --- | --- |
| `status` | `queued` / `running` / `finished` / `failed` / `rejected` / `cancelled` |
| `workflowId` | 按工作流 ID 过滤 |
| `search` | 搜索 runId / workflowId / workflow 名称 |
| `page`、`pageSize` | 分页 |

**POST /runs** 请求体：

```json
{
  "workflow": { "id": "...", "name": "...", "steps": [...] },
  "priority": 0,
  "traceId": "trace-xxx"
}
```

**GET /runs/:runId** 响应字段：

| 字段 | 说明 |
| --- | --- |
| `runId` | Run 标识 |
| `workflowId` | 工作流 ID |
| `workflowSnapshot` | 提交时的 workflow 快照 |
| `status` | 运行状态 |
| `traceId` | 链路追踪 ID |
| `counts` | `{ total, completed, failed, skipped }` |
| `createdAt` / `startedAt` / `finishedAt` | 时间戳 |
| `result` | 终态运行结果（序列化后的 `WorkflowRunResult`） |
| `events` | 已缓冲的生命周期事件数组 |
| `cancelled` | 取消时为 `"best-effort"` |

**POST /runs/:runId/cancel** 响应：

```json
{ "runId": "uuid", "status": "cancelled", "cancelled": "best-effort" }
```

---

### Resources · 资源与队列

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/resources` | 资源池快照 |
| GET | `/resources/queue` | 资源调度队列状态 |

**GET /resources** 响应示例：

```json
[
  { "id": "default-0", "type": "default", "name": "default-slot-0", "status": "available" }
]
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

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/stats/overview` | 实时聚合概览 |

响应示例：

```json
{
  "activeRuns": 0,
  "finishedRuns": 5,
  "failedRuns": 1,
  "successRate": 0.833,
  "pluginCount": 1,
  "queue": { "byType": { ... } }
}
```

---

### Test DevOps · 兼容验证（旧端点）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/test-devops` | 运行内置集成测试 workflow |

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

### 主通道 · `/runs/ws`

**连接地址**：`ws://localhost:3000/api/v1/devops/runs/ws`

#### 入站消息

| type | 格式 | 说明 |
| --- | --- | --- |
| `subscribe` | `{ "type": "subscribe", "runId": "uuid" }` | 订阅指定 Run；先回放已有事件，再接实时流 |
| `unsubscribe` | `{ "type": "unsubscribe", "runId": "uuid" }` | 取消订阅 |
| `run` | `{ "type": "run", "workflow": { ... } }` | 受理 Run 并自动订阅 |

#### 出站消息

| type | 格式 | 说明 |
| --- | --- | --- |
| `event` | `{ "type": "event", "event": { ... } }` | 生命周期事件（6 类，已序列化） |
| `done` | `{ "type": "done", "result": { ... } }` | Run 完成 |
| `error` | `{ "type": "error", "message": "..." }` | 错误 |

**生命周期事件类型**：`workflow:start`、`workflow:finished`、`step:queued`、`step:start`、`step:finished`、`plugin:log`

连接断开仅退订，Run 继续执行。

---

### 兼容通道 · `/test-devops/ws`

**连接地址**：`ws://localhost:3000/api/v1/devops/test-devops/ws`

#### 入站消息

| type | 格式 | 说明 |
| --- | --- | --- |
| `run` | `{ "type": "run", "workflow": { ... } }` | 向后兼容旧协议；内部 = 受理 Run + 自动订阅 |

#### 出站消息

与 `/runs/ws` 相同（`event` / `done` / `error`）。

---

## 接口总览（速查）

| # | 方法 | 路径 | 分组 |
| --- | --- | --- | --- |
| 1 | GET | `/` | 根 |
| 2 | GET | `/healthz` | 健康 |
| 3 | GET | `/plugins` | 插件 |
| 4 | GET | `/plugins/:name` | 插件 |
| 5 | POST | `/plugins/:name/dry-run` | 插件 |
| 6 | GET | `/workflows` | 工作流 |
| 7 | POST | `/workflows` | 工作流 |
| 8 | POST | `/workflows/validate` | 工作流 |
| 9 | GET | `/workflows/:id` | 工作流 |
| 10 | PUT | `/workflows/:id` | 工作流 |
| 11 | DELETE | `/workflows/:id` | 工作流 |
| 12 | POST | `/workflows/:id/run` | 工作流 |
| 13 | GET | `/runs` | 运行 |
| 14 | POST | `/runs` | 运行 |
| 15 | GET | `/runs/:runId` | 运行 |
| 16 | GET | `/runs/:runId/events` | 运行 |
| 17 | POST | `/runs/:runId/cancel` | 运行 |
| 18 | DELETE | `/runs/:runId` | 运行 |
| 19 | GET | `/resources` | 资源 |
| 20 | GET | `/resources/queue` | 资源 |
| 21 | GET | `/stats/overview` | 统计 |
| 22 | GET | `/test-devops` | 兼容 |
| 23 | WS | `/runs/ws` | WebSocket |
| 24 | WS | `/test-devops/ws` | WebSocket |

---

## 相关文档

- 设计方案：[docs/plans/server-api.md](../plans/server-api.md)
- 开发日志：[docs/dev-logs/server.md](./server.md)
