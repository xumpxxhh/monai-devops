# apps/web 开发日志

> 依据 [web-ui.md](../plans/web-ui.md) 与 [api-list.md](./api-list.md)，将 `apps/web` 从 Vite 脚手架升级为可演示的 MONAI DevOps 控制台，并对接 `apps/server` 完整 REST / WebSocket API。

**日期**：2026-07-01

---

## 背景与目标

### 改造前

- 仅 `Home`、`Test` 两个页面，无设计系统、无业务路由
- `Test.tsx` 通过 `test-devops/ws` 验证 WebSocket 闭环，但未沉淀为可复用数据层
- `index.css` 为 Vite 默认样式，无 Tailwind / token
- 无统一表单、弹层、状态展示组件

### 改造后

- **7 个业务视图**全部可导航演示（概览 / 工作流 / 编排器 / 运行 / 运行详情 / 插件 / 资源）
- **真实 API 闭环**：直接对接 `apps/server` REST + `WS /runs/ws`（未采用 web-ui.md 初稿中的 localStorage / mock 兜底，因后端已补齐接口）
- **Control Room (Light)** 视觉：Tailwind token + 原型动效（发光 DAG 节点、终端日志流）
- **分层清晰**：`shared/`（类型、API、hooks、UI）+ `features/` + `layouts/`
- **Radix 无头 + Tailwind 自研** 表单与弹层组件体系统一

---

## 技术选型

| 关注点 | 选型 |
| --- | --- |
| 框架 | Vite 8 + React 19 + react-router-dom 7 + TypeScript |
| 样式 | Tailwind CSS v3，token 自 `docs/prototype/assets/theme.js` 迁移 |
| 图标 | FontAwesome 6（`@fortawesome/react-fontawesome`） |
| 无头交互 | Radix UI（Dialog / Tabs / Select / Label / Checkbox） |
| DAG 画布 | `@xyflow/react`（编排器） |
| 类型 | `@monai-devops/core-engine` workspace 依赖 + 前端序列化镜像类型 |
| 测试 | Vitest + `run-state` reducer 单测 |

未引入：Ant Design / MUI、TanStack Query、Zustand（P0 阶段 hooks + 本地 state 足够）。

---

## 架构分层

```
layouts/          AppShell（侧栏+顶栏）、FullscreenLayout（编排器/运行详情）
    ↓
features/         dashboard、workflows、editor、runs、run-detail、plugins、resources
    ↓
shared/
├── types/        Workflow / Run / 事件序列化类型、UI 状态色映射
├── api/          http、workflows、runs、misc、workflow-run-client（WS）
├── hooks/        useWorkflowRun
└── ui/           StatusBadge、ProgressBar、Modal、Drawer、Tabs、表单组件…
config/env.ts     apiBaseUrl、routerBasename、getRunsWsUrl()
```

---

## 路由与数据源

| 路由 | 页面 | 布局 | 数据源 |
| --- | --- | --- | --- |
| `/` | 概览 Dashboard | AppShell | `GET /stats/overview` + 近期 `GET /runs` |
| `/workflows` | 工作流列表 | AppShell | `GET/POST/PUT/DELETE /workflows` |
| `/workflows/new`、`/workflows/:id/edit` | DAG 编排器 | 全屏 | React Flow + `POST /runs` 触发运行 |
| `/runs` | 运行列表 | AppShell | `GET /runs`（5s 轮询） |
| `/runs/:runId` | **运行详情** ★ | 全屏 | `GET /runs/:id` + `WS /runs/ws` subscribe |
| `/plugins` | 插件管理 | AppShell | `GET /plugins` + `POST /plugins/:name/dry-run` |
| `/resources` | 资源与调度 | AppShell | `GET /resources` + `GET /resources/queue` |
| `/test` | 集成测试（保留） | 独立 | 旧 `test-devops` HTTP/WS |

---

## 核心闭环

```
编排器编辑 WorkflowDefinition
    → POST /runs（或编排器内联提交）
    → 跳转 /runs/:runId
    → WS subscribe 接收 event / done / error
    → run-state reducer 聚合 DAG 节点状态 + 日志流
    → 结束后出现在 GET /runs 列表
```

**运行详情**为平台核心页：

- 左：事件驱动的 DAG 节点状态（`node-{status}` 发光环）
- 右：事件/日志流（全部 / 仅日志 / 仅错误过滤、自动滚动、暂停）
- 步骤抽屉：失败 / 跳过 / 排队等态下钻排障
- WS 断连 banner；取消运行按钮**禁用**（内核 AbortSignal 未实现，与计划 D4 一致）
- 刷新页面：`GET /runs/:runId` 回放 `events[]` 快照，进行中 Run 尝试重新 subscribe

---

## 新增 / 调整的文件

### 基础设施

```
apps/web/
├── tailwind.config.js          # 设计 token
├── postcss.config.js
├── vitest.config.ts
└── src/
    ├── index.css               # Tailwind + console.css 动效迁移
    └── config/env.ts           # 新增 getRunsWsUrl()，保留 getTestDevopsWsUrl()
```

### shared 层

```
src/shared/
├── types/index.ts              # RunRecord、序列化事件、分页响应等
├── types/status.ts             # StepUiStatus、RUN_STATUS_META
├── api/
│   ├── http.ts                 # apiGet/Post/Put/Delete + ApiError
│   ├── workflows.ts
│   ├── runs.ts
│   ├── misc.ts                 # plugins、resources、stats、health
│   └── workflow-run-client.ts  # WS：run / subscribe / unsubscribe
├── hooks/useWorkflowRun.ts
└── ui/
    ├── StatusBadge、ProgressBar、EmptyState、Modal、Drawer、Tabs
    ├── Sidebar、Topbar、WsPill
    └── form/                   # Radix 表单组件（见下节）
        ├── form-styles.ts
        ├── Field.tsx           # @radix-ui/react-label
        ├── Input.tsx
        ├── Textarea.tsx
        ├── Select.tsx          # @radix-ui/react-select
        ├── Checkbox.tsx        # @radix-ui/react-checkbox
        └── index.ts
```

### features 与 layouts

```
src/
├── layouts/AppShell.tsx
├── layouts/FullscreenLayout.tsx
├── features/
│   ├── dashboard/DashboardPage.tsx
│   ├── workflows/WorkflowsListPage.tsx
│   ├── editor/
│   │   ├── WorkflowEditorPage.tsx   # React Flow 三栏编排器
│   │   └── dag-utils.ts             # 环检测、id 唯一性
│   ├── runs/RunsListPage.tsx
│   ├── run-detail/
│   │   ├── RunDetailPage.tsx
│   │   ├── run-state.ts             # 事件聚合 reducer
│   │   └── run-state.test.ts
│   ├── plugins/PluginsPage.tsx
│   └── resources/ResourcesPage.tsx
└── App.tsx                        # 路由表重写
```

### 保留

| 文件 | 说明 |
| --- | --- |
| `pages/Test.tsx` | 旧集成测试页，仍可用于 `test-devops` 冒烟 |
| `pages/Home.tsx` | 未挂路由，可后续删除 |

### 文档

| 文件 | 变更 |
| --- | --- |
| `apps/web/README.md` | 环境变量、路由、联调说明 |

---

## 表单组件（Radix 自建）

在业务页面落地前，将散落的原生 `<input>` / `<select>` / `<textarea>` 统一为 `shared/ui/form/`：

| 组件 | Radix 基座 | 用途 |
| --- | --- | --- |
| `Field` | `react-label` | 标签 + hint / error |
| `Input` | —（样式封装） | 文本、搜索、数字 |
| `Textarea` | — | 多行、JSON 编辑 |
| `Select` | `react-select` | 插件选择、状态筛选 |
| `Checkbox` | `react-checkbox` | failFast、自动滚动等 |

已替换页面：编排器、运行列表、工作流列表、插件页、运行详情。

---

## 关键工程决策

| 决策 | 实现 |
| --- | --- |
| **对接真实 API** | 后端已有完整 REST/WS，跳过 localStorage / mock（与 web-ui.md §3 初稿策略不同） |
| **WS 主通道** | `/runs/ws`，`subscribe` 回放 + 实时；`/test-devops/ws` 仅 Test 页保留 |
| **事件聚合** | 纯函数 `applyRunEvent` / `hydrateRunState`，可单测 |
| **DAG 校验** | 前端 `validateDag`（环 + id 唯一）+ 后端 `POST /workflows/validate` 可扩展 |
| **取消运行** | UI 禁用 + tooltip，不做假交互 |
| **UI 组件库** | 无 Ant/MUI；Radix 行为 + Tailwind 上妆 |

---

## 环境变量

| 变量 | 说明 | 示例 |
| --- | --- | --- |
| `DEVOPS_API_BASE_URL` | 后端 API 基址（含 `GLOBAL_API_PREFIX`） | `http://localhost:3000/api/v1/devops` |
| `DEVOPS_BASE_PATH` | React Router `basename` | `/` |

WebSocket 地址由 `DEVOPS_API_BASE_URL` 推导：`…/runs/ws`。

---

## 验证情况

- [x] `pnpm --filter web build` 通过
- [x] `pnpm --filter web lint` 通过（`Test.tsx` 有一条 exhaustive-deps warning）
- [x] `pnpm --filter web test` 通过（`run-state.test.ts` 2 cases）
- [ ] 与 `apps/server` 端到端联调（编排 → 运行 → 实时详情）待人工验收

---

## 已知限制与后续迭代

| 项 | 说明 |
| --- | --- |
| 打包体积 | React Flow + Radix 导致主 chunk > 500KB，可做路由级 code split |
| 编排器布局 | 节点位置未持久化到 workflow 定义，刷新后 React Flow 自动排布 |
| 运行详情 DAG | 当前为 flex 节点列表 + 依赖边文案，非 React Flow 只读画布 |
| 全局 WS 状态 | AppShell 顶栏 `WsPill` 暂未接入全局连接（运行详情页独立订阅） |
| Toast / 确认框 | 删除工作流等操作为内联 Modal，未做全局 Toast 体系 |
| `pages/Home.tsx` | 死代码，可清理 |

建议下一步：

1. 配置 `.env` 后与 server 做端到端演示验收
2. 运行详情 DAG 升级为 React Flow 只读视图 + 流动连线
3. 路由 lazy load 缩小首屏 bundle
4. 全局 `WsStatusContext` 驱动顶栏连接 pill

---

## 参考文档

- 前端计划：[docs/plans/web-ui.md](../plans/web-ui.md)
- 后端接口：[docs/dev-logs/api-list.md](./api-list.md)
- 后端日志：[docs/dev-logs/server.md](./server.md)
- 原型：[docs/prototype/](../prototype/)
