# apps/web

MONAI DevOps 控制台前端：工作流可视化编辑、运行监控、插件试运行与资源队列查看。通过 REST + WebSocket 对接 `apps/server`。

## 技术栈

| 类别 | 选型 |
|---|---|
| 框架 | React 19 + TypeScript + Vite 8 |
| 路由 | react-router-dom 7（`BrowserRouter` + `basename`） |
| 样式 | Tailwind CSS 3（自定义 brand / status token） |
| DAG 画布 | `@xyflow/react` + `@dagrejs/dagre` 自动布局 |
| 表单 / 弹层 | Radix UI 原语 + 自研 `shared/ui` |
| 代码编辑 | CodeMirror 6（`@uiw/react-codemirror`） |
| 图标 / 字体 | Font Awesome + JetBrains Mono |
| Toast | sonner |
| 类型复用 | `@monai-devops/core-engine`（步骤 kind、DAG 校验、`$ref` 工具等） |
| 测试 | Vitest + Testing Library + jsdom |

不引入全局状态库：页面内 `useState` / 模块级单例（如共享 `WorkflowRunClient`、插件 schema 缓存）。

## 快速开始

### 前置

1. 仓库根目录 `pnpm install`
2. 后端已启动，且 API 前缀与前端 `DEVOPS_API_BASE_URL` 一致（见下方环境变量）

### 启动

```bash
# 仓库根
pnpm dev:web

# 或在 apps/web
pnpm dev
```

Vite 默认监听 `127.0.0.1`。开发环境读取 `.env.development`。

### 构建 / 预览

```bash
pnpm build      # tsc -b && vite build
pnpm preview
pnpm test       # vitest run
pnpm check-types
```

---

## 环境变量

Vite `envPrefix` 为 `DEVOPS_`（只有此前缀会注入客户端）。

| 变量 | 说明 | 开发默认（`.env.development`） | 生产（`.env.production`） |
|---|---|---|---|
| `DEVOPS_BASE_PATH` | React Router `basename`（静态资源 `base` 需另行配置时留意） | `/` | `/devops` |
| `DEVOPS_API_BASE_URL` | REST / SSE 根地址；WS 由其推导 | `http://localhost:3000/api/v1/devops` | `/api/v1/devops`（同源相对路径） |

WS 地址由 `getRunsWsUrl()` 生成：把 API URL 的协议换成 `ws`/`wss`，路径追加 `/runs/ws`。

本地联调时请保证 server 的 `GLOBAL_API_PREFIX` 与 `DEVOPS_API_BASE_URL` 路径段一致（例如两边都是 `api/v1/devops`）。`pnpm --filter server dev:test` 使用的 `.env.test` 前缀为 `api/v1/devops`，与当前 web 开发配置对齐。

---

## 路由

| 路径 | 布局 | 页面 |
|---|---|---|
| `/` | AppShell | 概览 Dashboard |
| `/workflows` | AppShell | 工作流列表 |
| `/runs` | AppShell | 运行列表 |
| `/plugins` | AppShell | 插件管理 / 试运行 |
| `/resources` | AppShell | 资源池与等待队列 |
| `/workflows/new` | Fullscreen | 新建工作流编辑器 |
| `/workflows/:id/edit` | Fullscreen | 编辑已有工作流 |
| `/runs/:runId` | 全屏详情 | 运行详情（DAG + 日志 + 控制） |
| `/test` | 独立 | 开发探测页 |

**AppShell**：侧栏导航 + 最近运行 + Topbar（环境标签、WS 状态、新建入口）。  
**FullscreenLayout**：编辑器用顶栏（返回 / 标题 / 保存·运行等操作）。

---

## 架构一览

```
src/
├── main.tsx / App.tsx
├── config/env.ts              # basename、API/WS URL
├── layouts/                   # AppShell、Sidebar、Topbar、FullscreenLayout
├── features/
│   ├── dashboard/             # KPI + 近期运行
│   ├── workflows/             # 列表、搜索、复制、展开 imports
│   ├── editor/                # React Flow 编辑器（核心）
│   ├── runs/                  # 运行列表
│   ├── run-detail/            # 实时 DAG、日志、cancel/pause/resume
│   ├── plugins/               # 插件列表 + SSE dry-run
│   └── resources/             # 资源槽位 / 队列轮询
├── shared/
│   ├── api/                   # http、workflows、runs、WS client、misc
│   ├── hooks/useWorkflowRun.ts
│   ├── plugins/               # PluginConfigForm + schema 预加载
│   ├── ui/                    # Modal、Drawer、Tabs、form、JsonSchemaForm、CodeEditor…
│   ├── dag/                   # dagre 布局、边 handle
│   ├── status/                # StatusBadge、ProgressBar
│   ├── types/                 # 与 server 序列化对齐的 DTO
│   └── ws/WsPill.tsx
└── pages/                     # Home / Test（遗留或探测）
```

数据流：

```
UI ──► shared/api/* ──► fetch / SSE ──► apps/server
UI ──► WorkflowRunClient ──► WebSocket /runs/ws ──► 事件 / done / error
RunDetail ◄── useWorkflowRun ◄── 共享 Client（按 runId 多路监听）
```

---

## 功能模块

### 概览（Dashboard）

- 拉取 `statsApi.overview`：进行中、成功率、排队步骤、插件数
- 近期运行列表；统计约每 10s 轮询一次

### 工作流列表

- 分页 / 搜索；行内展开已导入子工作流（reference / copy）
- 操作：编辑、运行（已存定义）、复制为新草稿（跳过含 `importId` 的 workflow 步骤以免无效引用）、删除

### 工作流编辑器（重点）

基于 React Flow 的全屏 DAG 编辑：

| 能力 | 说明 |
|---|---|
| 调色板 | 已注册插件、内置 `set_state` / `workflow`、已导入子工作流 |
| 连线 | `dependsOn`；本地 `validateDag`（复用 core-engine） |
| 节点检查器 | 名称、条件、优先级、`resourceType`；按 kind 配置面板 |
| 插件配置 | `JsonSchemaForm` + 上游 `$ref`（祖先步骤 / `__workflow_state__`） |
| 内置步骤 | `BuiltinStepPanels`：`patch`、`inputState`、`loop` 等 |
| 导入 | `ImportWorkflowModal`：`reference` / `copy` |
| 工作流设置 | 名称、`stateSchema`（JSON） |
| 保存 | 新建 `POST /workflows`，更新 `PUT /workflows/:id`；保存前校验全部步骤 config |
| 运行 | 将当前草稿 `POST /runs`（可不先保存）；成功后跳转运行详情 |

步骤 config 校验见 `step-config-validation.ts`（对照后端下发的插件 JSON Schema；内置 kind 有合成 `resultSchema` 供 `$ref` 选字段）。

自动布局：`shared/dag/flow-layout`（dagre），支持横/纵方向。

### 运行列表 / 详情

- 列表：状态筛选、搜索、删除终态 Run（`notifyRunsChanged` 刷新侧栏）
- 详情：
  1. REST 拉 Run + 事件，`hydrateRunState` 还原步骤态与日志
  2. `useWorkflowRun` 订阅 WS，增量 `applyRunEvent`
  3. DAG 节点状态着色；日志支持按嵌套迭代折叠
  4. 控制：`cancel`（best-effort / hard）、`pause`、`resume`

嵌套子工作流**不单独建详情页**：父 Run 事件流中的 `parent` / `workflow:iteration:*` 驱动 UI（迭代时间线、嵌套日志分组）。

### 插件页

- 列表 + 选中后的 `PluginConfigForm`
- `POST /plugins/:name/dry-run`（SSE）：实时日志 + 最终 `ExecutionResult`
- 试运行 config **不能含 `$ref`**（与后端一致）

### 资源与调度

- `GET /resources`、`/resources/queue`
- 队列约每 5s 轮询；展示按 `resourceType` 的排队 / 占用数

---

## API 与实时层

### HTTP（`shared/api`）

| 模块 | 职责 |
|---|---|
| `http.ts` | `apiGet/Post/Put/Delete`、`apiPostSse`；错误包装为 `ApiError` |
| `workflows.ts` | 工作流 CRUD、validate、run、imports；`WorkflowDraft` 类型 |
| `runs.ts` | Run 列表/详情/事件/控制 |
| `misc.ts` | plugins（含 dry-run）、resources、stats、health、system |
| `runs-events.ts` | 轻量发布订阅，刷新「最近运行」 |

所有路径相对 `DEVOPS_API_BASE_URL`，**不要**再写全局前缀。

### WebSocket（`workflow-run-client.ts`）

- 单例 `getSharedWorkflowRunClient()`
- 协议：`subscribe` / `unsubscribe` / `run`（入站）；`event` / `done` / `error`（出站）
- 按 `runId` 维护多 listener；无监听时关闭连接
- `useWorkflowRun`：可选自动订阅、`fromEventIndex` 跳过 REST 已加载的 replay

---

## 共享 UI 与表单

| 目录 / 组件 | 用途 |
|---|---|
| `shared/ui/form` | Input、Select、Switch、Checkbox、Field、Cascader、Textarea |
| `shared/ui/json-schema-form` | 按 JSON Schema 渲染插件配置；支持 ContextRef 级联选字段、类型兼容校验 |
| `shared/plugins` | `PluginConfigForm` / Modal、`preloadPluginConfigSchemas` |
| `shared/ui/code-editor` | JSON 等 CodeMirror 封装 |
| Modal / Drawer / Tabs / Toast / EmptyState / DropdownMenu | 通用交互 |
| `StatusBadge` / `ProgressBar` | 运行与步骤状态 |

设计 token（`tailwind.config.js`）：`brand`、`canvas`/`surface`、状态色 `completed`/`running`/`queued`/`failed`/`skipped`，圆角 `card`/`ctrl`/`pill`。

---

## 与 core-engine / server 的关系

- **类型与纯函数**：直接依赖 workspace 包 `core-engine`（如 `StepKinds`、`extractContextReferences`、`validateDag`、`WORKFLOW_STATE_REF_ID`），保证编辑器校验与引擎语义一致。
- **运行时执行**：全部走 server；前端不实例化引擎。
- **DTO**：`shared/types` 描述服务端序列化后的 Run / Event / Plugin schema，与 Prisma/Nest 返回形态对齐（日期多为 ISO 字符串）。

---

## 目录速查（编辑器相关）

```
features/editor/
├── WorkflowEditorPage.tsx   # 画布 + 保存/运行编排
├── StepInspectorPanel.tsx   # 选中节点属性
├── BuiltinStepPanels.tsx    # set_state / workflow 面板
├── ImportWorkflowModal.tsx
├── WorkflowSettingsModal.tsx
├── EditableWorkflowTitle.tsx
├── dag-utils.ts             # DAG / 祖先 id
├── step-config-validation.ts
└── workflow-name.ts
```

```
features/run-detail/
├── RunDetailPage.tsx
├── DagStepNode.tsx
└── run-state.ts             # 事件归约、日志、步骤视图
```

---

## 脚本

| 脚本 | 作用 |
|---|---|
| `pnpm dev` / `dev:test` | Vite 开发服（二者当前等价，均靠 `.env.*`） |
| `pnpm build` | 类型检查 + 生产构建 |
| `pnpm preview` | 预览构建产物 |
| `pnpm test` | Vitest |
| `pnpm check-types` | `tsc -b` |
| `pnpm lint` / `format` | ESLint / Prettier |

主要单测覆盖：`dag-utils`、`step-config-validation`、`run-state`、`json-schema-form`（schema / context-ref）。

---

## 开发备忘

- **无登录**：所有请求裸调后端；生产需网关或后续加鉴权头。
- **AppShell 的 WsPill**：当前 shell 里 `wsStatus` 写死为 `disconnected`；真实连接状态在运行详情页通过 `useWorkflowRun` 展示。
- **草稿 id**：编辑器可用 `clientRef` 在未落库前标识节点；保存时由服务端规范化正式 `step.id`。
- **复制工作流**：列表「复制」会丢掉 `kind: workflow` 步骤，需在新工作流中重新导入子流。
- **浏览器支持**：现代 Chromium / Firefox / Safari；依赖 `fetch` 流式读取（SSE dry-run）与原生 WebSocket。
