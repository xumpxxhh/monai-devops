# MONAI DevOps 控制台 (apps/web)

基于 Vite + React 19 的 DevOps 控制台前端，对接 `apps/server` REST / WebSocket API。

## 环境变量

在 `apps/web/.env` 或根目录 `.env` 中配置（`DEVOPS_` 前缀）：

| 变量 | 说明 | 示例 |
| --- | --- | --- |
| `DEVOPS_API_BASE_URL` | 后端 API 基址（含全局前缀） | `http://localhost:3000/api/v1/devops` |
| `DEVOPS_BASE_PATH` | 前端路由 basename | `/` |

## 启动

```bash
# 根目录：同时启动 server + web
pnpm dev

# 仅前端
pnpm dev:web
```

请确保 `apps/server` 已启动且 `DEVOPS_API_BASE_URL` 指向正确地址。

## 页面路由

| 路由 | 功能 |
| --- | --- |
| `/` | 概览 Dashboard |
| `/workflows` | 工作流列表 |
| `/workflows/new` · `/workflows/:id/edit` | DAG 编排器 |
| `/runs` | 运行列表 |
| `/runs/:runId` | 运行详情（WebSocket 实时） |
| `/plugins` | 插件管理 + 单步试运行 |
| `/resources` | 资源池与调度队列 |
| `/test` | 旧版集成测试页（保留） |

## 脚本

```bash
pnpm build    # 类型检查 + 生产构建
pnpm test     # Vitest（含 run-state reducer 单测）
pnpm lint     # ESLint
```

## 与后端联调

- HTTP：工作流 CRUD、运行列表/详情、插件、资源、统计均走 REST（见 `docs/dev-logs/api-list.md`）
- WebSocket：`/runs/ws`，支持 `subscribe` / `run` 消息
- 运行详情页对进行中的 Run 自动订阅；刷新后可从 `GET /runs/:runId` 回放已缓冲事件
