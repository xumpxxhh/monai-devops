# Web（apps/web）

`apps/web` 是 `monai-devops` 的 **DevOps 控制台前端**，基于 Vite + React 19 构建，对接 `apps/server` 的 REST 与 WebSocket API，提供 **编排 → 运行 → 观测 → 排障** 的完整 Web 闭环。

设计基调为 **Control Room (Light)**：浅灰画布 + 电光紫品牌色 + 与内核语义对齐的状态色；签名元素为「带发光状态环的 DAG 节点」与「类终端的实时日志流」。

---

## 1. 功能概览

### 核心能力

| 视图                 | 路由                                     | 说明                                                                                                                           |
| -------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **概览 Dashboard**   | `/`                                      | 平台健康度快照：进行中运行数、成功率、排队步骤、插件数；10s 自动刷新                                                           |
| **工作流列表**       | `/workflows`                             | 搜索、创建、复制、删除、一键运行                                                                                               |
| **工作流编排器**     | `/workflows/new` · `/workflows/:id/edit` | 三栏可视化 DAG；支持 `plugin` / `workflow` / `set_state`；导入子工作流；`stateSchema` 表单+JSON 双入口；环检测复用 core-engine |
| **运行列表**         | `/runs`                                  | 按状态 / 关键词筛选，进行中置顶，5s 轮询                                                                                       |
| **运行详情** ★       | `/runs/:runId`                           | 实时 DAG + 事件/日志；嵌套日志与迭代抽屉；支持暂停 / 继续 / 取消                                                               |
| **插件管理**         | `/plugins`                               | 已注册插件列表 + JSON Schema 配置表单 + 单步试运行（SSE 流式日志）                                                             |
| **资源与调度**       | `/resources`                             | 资源池占用 + 按类型调度队列，解释「为什么排队」                                                                                |
| **集成测试（遗留）** | `/test`                                  | 旧版 `test-devops` HTTP / WebSocket 冒烟页，保留用于联调                                                                       |

### 当前实现特性（重要）

- **全量对接真实后端 API**：工作流 CRUD、运行管理、插件、资源、统计均走 `apps/server` REST，无 localStorage / mock 兜底。
- **WebSocket 主通道**：`/runs/ws`，支持 `subscribe` / `unsubscribe` / `run`；运行详情页对进行中的 Run 自动订阅。
- **事件聚合**：纯函数 `applyRunEvent` / `hydrateRunState` 将生命周期事件聚合为 DAG 节点状态与日志流，可单测。
- **插件配置**：基于后端导出的 JSON Schema 动态渲染表单（`JsonSchemaForm` / `PluginConfigForm`）。
- **无全局状态库**：P0 阶段使用 React hooks + 本地 state；未引入 TanStack Query / Zustand。
- **无认证层**：当前版本未实现登录 / 鉴权，假定内网或开发环境使用。

---

## 2. 项目结构（apps/web）

```txt
src/
  config/
    env.ts                 # apiBaseUrl、routerBasename、WebSocket URL 推导
  layouts/
    AppShell.tsx           # 侧栏 + 顶栏 + 主内容区（常规页面）
    FullscreenLayout.tsx   # 全屏顶栏（编排器）
  features/
    dashboard/             # 概览 KPI + 近期运行
    workflows/             # 工作流列表
    editor/                # DAG 编排器（React Flow、dag 校验、步骤配置校验）
    runs/                  # 运行列表
    run-detail/            # 运行详情（DAG 画布、日志流、步骤抽屉、run-state reducer）
    plugins/               # 插件列表 + dry-run
    resources/             # 资源池 + 调度队列
  shared/
    types/                 # 序列化类型、RunRecord、分页响应、UI 状态色映射
    api/
      http.ts              # apiGet/Post/Put/Delete、apiPostSse、ApiError
      workflows.ts         # 工作流 CRUD / validate / run
      runs.ts              # 运行列表 / 详情 / 控制（cancel、pause、resume）
      misc.ts              # plugins、resources、stats、health
      workflow-run-client.ts  # WebSocket 客户端（单例共享连接）
    hooks/
      useWorkflowRun.ts    # WS 订阅 / 运行封装
    dag/
      flow-layout.ts       # dagre 自动布局、连线样式
      FlowNodeHandles.tsx  # 四向连接点
    ui/
      form/                # Radix 无头 + Tailwind 表单组件
      json-schema-form/    # 插件配置 JSON Schema 表单
      Sidebar、Topbar、Modal、Drawer、Tabs、StatusBadge…
  pages/
    Test.tsx               # 遗留集成测试页
  App.tsx                  # 路由表
  main.tsx                 # 入口（BrowserRouter + Toaster）
```

---

## 3. 前置要求

- Node.js `>= 20`
- pnpm（仓库根目录 `packageManager` 当前为 `pnpm@10.18.2`）
- 已启动的 `apps/server`（内存存储，重启后数据丢失）

在仓库根目录安装依赖：

```bash
pnpm install
```

---

## 4. 环境变量

Vite 仅加载 **`apps/web/` 目录下** 的环境文件（`envPrefix: DEVOPS_`）。推荐创建 `apps/web/.env.local`：

| 变量名                | 是否必填 | 默认值 | 说明                                                        |
| --------------------- | -------- | ------ | ----------------------------------------------------------- |
| `DEVOPS_API_BASE_URL` | 是       | 无     | 后端 API 基址，**须包含** `GLOBAL_API_PREFIX`。示例见下     |
| `DEVOPS_BASE_PATH`    | 否       | `/`    | React Router `basename`；部署在子路径时需设置，如 `/devops` |

示例（`apps/web/.env.local`）：

```env
DEVOPS_API_BASE_URL=http://localhost:3000/api/v1/devops
DEVOPS_BASE_PATH=/
```

> `DEVOPS_API_BASE_URL` 必须与 `apps/server` 的 `GLOBAL_API_PREFIX` 一致。若服务端配置为 `GLOBAL_API_PREFIX=api/v1/devops`，则基址为 `http://localhost:3000/api/v1/devops`。

WebSocket 地址由 `DEVOPS_API_BASE_URL` 自动推导（`http` → `ws`，`https` → `wss`）：

| 用途                      | 推导路径           |
| ------------------------- | ------------------ |
| 运行订阅（主通道）        | `…/runs/ws`        |
| 集成测试（仅 `/test` 页） | `…/test-devops/ws` |

---

## 5. 启动与构建

建议在仓库根目录执行（Turbo 会按 workspace 过滤）：

```bash
# 同时启动 server + web
pnpm dev

# 仅前端（默认 http://127.0.0.1:5173）
pnpm dev:web
```

也可在 `apps/web` 目录直接执行：

```bash
pnpm dev        # 开发热更新
pnpm build      # tsc -b + Vite 生产构建
pnpm preview    # 预览生产构建
```

启动前请确认：

1. `apps/server` 已运行（默认 `http://localhost:3000`）
2. `DEVOPS_API_BASE_URL` 指向正确的 API 前缀

---

## 6. 路由与布局

| 路由                  | 页面组件             | 布局     | 主要数据源                                    |
| --------------------- | -------------------- | -------- | --------------------------------------------- |
| `/`                   | `DashboardPage`      | AppShell | `GET /stats/overview`、`GET /runs`            |
| `/workflows`          | `WorkflowsListPage`  | AppShell | `GET/POST/PUT/DELETE /workflows`              |
| `/workflows/new`      | `WorkflowEditorPage` | 全屏     | React Flow + `POST /workflows`                |
| `/workflows/:id/edit` | `WorkflowEditorPage` | 全屏     | `GET/PUT /workflows/:id`                      |
| `/runs`               | `RunsListPage`       | AppShell | `GET /runs`（5s 轮询）                        |
| `/runs/:runId`        | `RunDetailPage`      | 全屏     | `GET /runs/:id` + `WS /runs/ws`               |
| `/plugins`            | `PluginsPage`        | AppShell | `GET /plugins`、`POST /plugins/:name/dry-run` |
| `/resources`          | `ResourcesPage`      | AppShell | `GET /resources`、`GET /resources/queue`      |
| `/test`               | `Test`               | 独立     | `GET /test-devops`、`WS /test-devops/ws`      |

侧栏导航（`Sidebar`）：概览 → 工作流 → 运行 → 插件 → 资源与调度；底部展示最近 5 条运行快捷入口。

---

## 7. 核心用户闭环

```txt
编排器编辑 WorkflowDefinition
    → POST /workflows/:id/run 或 POST /runs
    → 跳转 /runs/:runId
    → WS subscribe 接收 event / done / error
    → run-state reducer 聚合 DAG 节点状态 + 日志流
    → 结束后出现在 GET /runs 列表与 Dashboard 统计
```

### 运行详情页（平台核心）

- **左侧**：React Flow 只读 DAG，节点带 `node-{status}` 发光状态环（idle / queued / running / completed / failed / skipped）
- **右侧**：事件 / 日志流，支持全部 / 仅日志 / 仅错误过滤、自动滚动、暂停滚动
- **步骤抽屉**：点击节点下钻查看配置、结果、失败原因、跳过原因
- **运行控制**：对进行中的 Run 支持暂停（`POST /runs/:id/pause`）、继续（`resume`）、取消（`cancel`，含 best-effort / hard 两种模式）
- **断线恢复**：刷新页面时 `GET /runs/:runId` 回放 `events[]` 快照；若 Run 仍在进行中，自动重新 `subscribe`
- **WebSocket 状态**：顶栏 `WsPill` 显示连接状态（connecting / connected / disconnected / error）

---

## 8. 数据层与 API 映射

前端 API 模块位于 `src/shared/api/`，统一通过 `http.ts` 发起请求；错误统一封装为 `ApiError`（含 `status`、`body`）。

### 工作流（`workflows.ts`）

| 方法       | 后端路径                   | 用途            |
| ---------- | -------------------------- | --------------- |
| `list`     | `GET /workflows`           | 分页列表 + 搜索 |
| `get`      | `GET /workflows/:id`       | 详情            |
| `create`   | `POST /workflows`          | 创建            |
| `update`   | `PUT /workflows/:id`       | 更新            |
| `remove`   | `DELETE /workflows/:id`    | 删除            |
| `validate` | `POST /workflows/validate` | DAG 校验        |
| `run`      | `POST /workflows/:id/run`  | 触发运行        |

### 运行（`runs.ts`）

| 方法        | 后端路径                   | 用途                       |
| ----------- | -------------------------- | -------------------------- |
| `list`      | `GET /runs`                | 分页列表 + 状态 / 搜索筛选 |
| `get`       | `GET /runs/:runId`         | 详情（含 `events[]` 快照） |
| `submit`    | `POST /runs`               | 直接提交 workflow 定义运行 |
| `getEvents` | `GET /runs/:runId/events`  | 事件列表                   |
| `cancel`    | `POST /runs/:runId/cancel` | 取消运行                   |
| `pause`     | `POST /runs/:runId/pause`  | 暂停                       |
| `resume`    | `POST /runs/:runId/resume` | 继续                       |
| `remove`    | `DELETE /runs/:runId`      | 删除历史                   |

### 插件 / 资源 / 统计（`misc.ts`）

| 模块           | 主要接口                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------ |
| `pluginsApi`   | `GET /plugins`、`GET /plugins/config-schemas`、`GET /plugins/result-schemas`、`POST /plugins/:name/dry-run`（SSE） |
| `resourcesApi` | `GET /resources`、`GET /resources/queue`                                                                           |
| `statsApi`     | `GET /stats/overview`                                                                                              |
| `healthApi`    | `GET /healthz`                                                                                                     |
| `systemApi`    | `GET /system/info`                                                                                                 |

完整接口契约见 [`docs/dev-logs/api-list.md`](../../docs/dev-logs/api-list.md)。

---

## 9. WebSocket 协议（前端视角）

客户端实现：`WorkflowRunClient`（`workflow-run-client.ts`），通过 `getSharedWorkflowRunClient()` 单例共享连接。

### 客户端发送

```json
{ "type": "subscribe", "runId": "<run-id>" }
{ "type": "unsubscribe", "runId": "<run-id>" }
{ "type": "run", "workflow": { "id": "...", "name": "...", "steps": [...] } }
```

### 服务端推送

```json
{ "type": "event", "runId": "...", "event": { "type": "step:start", ... } }
{ "type": "done", "runId": "...", "result": { "success": true, "status": "success", ... } }
{ "type": "error", "runId": "...", "message": "..." }
```

### 生命周期事件类型

与 `@monai-devops/core-engine` 对齐，前端通过 `applyRunEvent` 处理：

- `workflow:start` / `workflow:finished`
- `step:queued` / `step:start` / `step:finished`
- `plugin:log`（含 `stdout` / `stderr` 流，后端会合并连续同流日志）

### React Hook

`useWorkflowRun({ runId, autoSubscribe, onEvent, onDone, onError })` 封装订阅生命周期，组件卸载时自动 `unsubscribe`；无监听者时关闭 WebSocket 连接。

---

## 10. 技术选型

| 关注点   | 选型                                                            |
| -------- | --------------------------------------------------------------- |
| 框架     | Vite 8 + React 19 + react-router-dom 7 + TypeScript             |
| 样式     | Tailwind CSS v3，设计 token 定义于 `tailwind.config.js`         |
| 图标     | FontAwesome 7（`@fortawesome/react-fontawesome`）               |
| 无头交互 | Radix UI（Dialog、Tabs、Select、Checkbox、DropdownMenu、Toast） |
| 通知     | sonner（`shared/ui/Toast.tsx` 封装）                            |
| DAG 画布 | `@xyflow/react` + `@dagrejs/dagre` 自动布局                     |
| 类型     | `@monai-devops/core-engine` workspace 依赖 + 前端序列化镜像类型 |
| 测试     | Vitest + jsdom                                                  |

**未引入**：Ant Design / MUI、TanStack Query、Zustand。

---

## 11. 设计系统

Token 定义于 `tailwind.config.js`，主要语义色：

| Token                                                     | 用途             |
| --------------------------------------------------------- | ---------------- |
| `brand`                                                   | 品牌紫 `#6D5EF6` |
| `canvas` / `surface` / `panel`                            | 背景层级         |
| `ink` / `muted` / `faint`                                 | 文字层级         |
| `completed` / `running` / `queued` / `failed` / `skipped` | 步骤与运行状态色 |

步骤 UI 状态映射见 `src/shared/types/status.ts`（`STATUS_META`、`RUN_STATUS_META`）。

编排器节点选中时带 `node-selected` 发光环；运行详情 DAG 节点按状态附加 `node-{status}` CSS 类。

---

## 12. 编排器要点

`WorkflowEditorPage` 为三栏布局：

1. **左栏**：插件 + 内置步骤（`GET /plugins` + `GET /step-kinds`），拖拽或点击添加到画布
2. **中栏**：React Flow 画布，支持连线（`dependsOn`）、自动 dagre 布局（LR / TB）、MiniMap；`workflow` / `set_state` 节点样式区分于插件
3. **右栏**：选中步骤的属性编辑（按 `kind` 分支；`workflow` 步骤从已导入列表选 `importId`，禁止裸填 `workflowId`）

另有：**导入子工作流**（引用/拷贝）、「子工作流」二级表格（reference 只读查看，copy 可跳转编辑）、工作流级 **stateSchema** 编辑器（表单构建器 + JSON 手填）。

保存前校验：

- 前端复用 core-engine `validateDag`：步骤 id 唯一性、依赖存在性、环检测
- `validateStepConfig` / `validateAllStepConfigs`：步骤配置字段校验；无 `stateSchema` 时拦截含 `set_state` 的草稿
- 可调用后端 `POST /workflows/validate` 做服务端校验

插件配置通过 `PluginConfigFormModal` 打开，基于 `GET /plugins/config-schemas` 预加载 JSON Schema。

每个配置字段支持 **手填 / 引用上游** 二态切换：

- 可引用上游 = 当前步骤的祖先步骤 ∩（插件声明了 `resultSchema` **或** 内置 kind 固定 schema）
- 引用模式将字段值整体设为 `{ $ref: { fromStepId, path } }`（不支持字符串内混合插值）
- 设计时校验对 `ContextRef` 跳过类型检查，仍计为已填；权威校验在保存时由服务端 `validateWorkflowContextReferences` 兜底

运行详情：`run-state` 理解事件 `parent` 与 `workflow:iteration:*`，嵌套日志入父事件流，迭代抽屉展示 `nestedLogs`（不再依赖 `children` API / 独立子 run 页）。

> 节点坐标**未持久化**到 workflow 定义；刷新后由 dagre 重新排布。

---

## 13. 脚本与测试

在 `apps/web` 目录：

```bash
pnpm dev          # 开发服务器（127.0.0.1:5173）
pnpm build        # 类型检查 + 生产构建（输出 dist/）
pnpm preview      # 预览生产构建
pnpm test         # Vitest 单元测试
pnpm lint         # ESLint
pnpm lint:fix     # ESLint 自动修复
pnpm format       # Prettier 格式化
pnpm format:check # Prettier 检查
```

当前测试覆盖：

| 文件                             | 覆盖内容                                               |
| -------------------------------- | ------------------------------------------------------ |
| `run-state.test.ts`              | 事件聚合 reducer（`applyRunEvent`、`hydrateRunState`） |
| `step-config-validation.test.ts` | 步骤配置校验                                           |
| `schema-utils.test.ts`           | JSON Schema 表单工具函数                               |

---

## 14. 与后端联调

### 快速验证路径

1. 根目录 `pnpm dev` 同时启动 server + web
2. 浏览器打开 `http://127.0.0.1:5173`
3. 进入 **工作流** → 编辑内置 workflow 或新建 → **运行**
4. 自动跳转运行详情，观察 DAG 节点状态与日志流实时更新

### HTTP 与 WebSocket 分工

| 场景                                 | 通道                                                       |
| ------------------------------------ | ---------------------------------------------------------- |
| 列表、CRUD、统计、资源查询           | REST                                                       |
| 运行详情实时事件、编排器内联 WS 运行 | WebSocket `/runs/ws`                                       |
| 插件 dry-run 流式日志                | REST SSE `POST /plugins/:name/dry-run`                     |
| 遗留集成测试                         | `GET /test-devops` + `WS /test-devops/ws`（仅 `/test` 页） |

### 常见问题

| 现象               | 排查                                                                             |
| ------------------ | -------------------------------------------------------------------------------- |
| 所有 API 请求失败  | 检查 `DEVOPS_API_BASE_URL` 是否与 server 的 `GLOBAL_API_PREFIX` 一致             |
| WebSocket 无法连接 | 确认 `DEVOPS_API_BASE_URL` 已配置；检查 server 是否监听对应端口                  |
| 运行详情无实时更新 | 查看 `WsPill` 状态；进行中 Run 应自动 subscribe；刷新后会从 `GET /runs/:id` 回放 |
| 插件配置表单为空   | 确认插件已注册（`pnpm sync:plugins`）且后端 `GET /plugins/config-schemas` 有数据 |

---

## 15. 已知限制与后续迭代

| 项               | 说明                                                              |
| ---------------- | ----------------------------------------------------------------- |
| 打包体积         | React Flow + Radix 导致主 chunk 较大，可做路由级 code split       |
| 编排器布局       | 节点位置未持久化，刷新后 dagre 重新排布                           |
| 全局 WS 状态     | AppShell 顶栏 `WsPill` 暂未接入全局连接状态（运行详情页独立订阅） |
| 认证             | 无登录 / 鉴权，不适合直接暴露公网                                 |
| 数据持久化       | 依赖 server 内存存储，服务重启后工作流与运行历史丢失              |
| `pages/Home.tsx` | 未挂路由，可后续清理                                              |

建议下一步：

1. 路由 lazy load 缩小首屏 bundle
2. 全局 `WsStatusContext` 驱动顶栏连接 pill
3. 编排器节点坐标可选持久化到 workflow metadata
4. 对接持久化存储与认证层

---

## 16. 参考文档

- 前端开发计划：[docs/plans/web-ui.md](../../docs/plans/web-ui.md)
- 前端开发日志：[docs/dev-logs/web.md](../../docs/dev-logs/web.md)
- 后端接口清单：[docs/dev-logs/api-list.md](../../docs/dev-logs/api-list.md)
- 后端服务说明：[apps/server/README.md](../server/README.md)
- 高保真原型：[docs/prototype/](../../docs/prototype/)
