# apps/web 前端开发计划 · MONAI DevOps 控制台

> 依据 `docs/prototype/` 高保真原型（7 个视图）与现有内核 / 后端契约，给出 `apps/web`
> 从脚手架到可演示控制台的分阶段开发计划。
>
> 设计基调：**Control Room (Light)** —— 洁净浅灰底 + 电光紫品牌色 + 一套贴合内核语义的状态色；
> 签名元素是「带发光状态环的 DAG 节点」与「类终端的实时日志流」。

---

## 1. 目标与范围

把内核的 **DAG 编排 → 实时调度 → 结构化事件** 变成一个人能看懂、点得动的 Web 控制台，形成
**编排 → 运行 → 观测 → 排障** 的闭环。

原型共 **7 个视图**：

| 视图 | 文件 | 原型优先级 | 核心价值 |
| --- | --- | --- | --- |
| 概览 Dashboard | `dashboard.html` | V2 | 平台健康度快照（进行中、成功率、资源、插件数） |
| 工作流列表 | `workflows.html` | P0 | 管理工作流，搜索、一键运行、进编排器 |
| 工作流编排器 | `workflow-editor.html` | P0 | 三栏可视化 DAG 编辑 + 环检测 + 发起运行 |
| 运行列表 | `runs.html` | P0 | 筛选状态/工作流/时间，进行中置顶 |
| **运行详情** ★ | `run-detail.html` | **核心** | 实时 DAG 状态视图 + 事件/日志流 + 单步下钻排障 |
| 插件管理 | `plugins.html` | P1 | 已注册插件列表 + 单步试运行 |
| 资源与调度 | `resources.html` | P1 | 资源池占用 + 调度队列，解释「为什么排队」 |

---

## 2. 现状盘点

### 2.1 前端脚手架（起点）

- 技术栈：**Vite 8 + React 19 + react-router-dom 7 + TypeScript**（见 `apps/web/package.json`）。
- 当前仅 2 个页面：`Home`、`Test`，路由在 `src/App.tsx`。
- `src/config/env.ts` 已具备对接基础设施：
  - `routerBasename`（来自 `DEVOPS_BASE_PATH`）
  - `apiBaseUrl`（来自 `DEVOPS_API_BASE_URL`，含全局前缀）
  - `getTestDevopsWsUrl()`（由 API 基址推导 ws/wss 地址）
- `src/pages/Test.tsx` **已经是一份可复用的对接范式**：HTTP 冒烟 + WebSocket 提交 workflow + 解析 `event/done/error`、`onopen/onmessage/onerror/onclose` 全生命周期、组件卸载时关闭连接。**P0 的数据层应从这里抽象沉淀，而非重写。**
- 尚缺：**无 Tailwind、无设计 token、无 UI 组件库、无状态管理、无统一数据层**。`src/index.css` 仍是 Vite 模板默认样式（需替换）。

### 2.2 后端 / 内核契约（硬约束）

> ⚠️ 这是决定计划如何分期的最关键事实：**原型描绘的能力远多于当前后端暴露的接口。**

当前 `apps/server` 对外仅有：

| 类型 | 路径 | 说明 |
| --- | --- | --- |
| HTTP `GET` | `/{prefix}` | 返回 `"Hello World!"` |
| HTTP `GET` | `/{prefix}/test-devops` | 硬编码运行一个 workflow，一次性返回 `IntegrationTestResult` |
| WebSocket | `/{prefix}/test-devops/ws` | 发 `{ type:'run', workflow }`，收 `event` / `done` / `error` |

**缺口（原型需要、后端尚无）**：

- ❌ 工作流持久化 / 列表 / 详情 / 删除（CRUD）
- ❌ 运行历史 / 运行列表查询
- ❌ 插件注册表列表 API（仅注册了 1 个 `test-plugin`）
- ❌ 资源池占用 / 调度队列查询 API（内核有 `getQueueStatus`，未对外）
- ❌ 单步 `executeStep` 的 HTTP 入口
- ❌ 运行取消（内核 AbortSignal 未实现，原型里「取消运行」按钮即为禁用态）
- ❌ 认证 / 鉴权
- ⚠️ WebSocket **单连接单任务**：执行中再发消息返回 `error`

**WebSocket 出站消息（已序列化）**：

```ts
type WsOutboundMessage =
  | { type: 'event'; event: WorkflowLifecycleEventSerialized }
  | { type: 'done'; result: WorkflowRunResultSerialized }
  | { type: 'error'; message: string };
```

**6 种生命周期事件**（discriminated union，详见 `packages/core-engine/observer/types.ts`）：

```5:63:packages/core-engine/observer/types.ts
export type WorkflowLifecycleEvent =
  | { type: 'workflow:start'; meta; workflow }
  | { type: 'workflow:finished'; meta; result }
  | { type: 'step:queued'; meta; step; resourceType; priority }
  | { type: 'step:start'; meta; step }
  | { type: 'step:finished'; meta; step; result }
  | { type: 'plugin:log'; meta; step; log };
```

**关键枚举**（`packages/core-engine/errors.ts`，前端状态色/文案直接映射）：

- `StepStatus`: `completed | skipped | failed`
- `StepFailureKind`: `plugin | resource | internal`
- `SkipReason`: `condition_not_met | dependency_failed | workflow_aborted`
- 运行中前端额外派生 `running` / `queued` / `idle`（事件驱动，非终态）

> 序列化注意：`Error` 被转为 `{ name, message }`（**无 stack**）；前端排障 UI 据此渲染。

---

## 3. 关键决策与差距策略

原型是「理想态」，后端是「现实态」。本计划用**两条腿走路**弥合差距：

1. **真实闭环优先（P0）**：凡是后端 WebSocket 链路能真正驱动的，全部接真数据 ——
   即「**编排器编出 workflow → ws 发起运行 → 运行详情实时渲染 DAG + 日志**」这条主线。
   这是平台最核心、也最能体现内核价值的闭环，且**完全可用现有后端跑通**。

2. **适配层兜底 + 待后端补齐（P1/P2）**：工作流列表、运行历史、插件列表、资源队列等后端暂无接口的部分，
   前端定义**清晰的数据访问接口（Repository / Service 抽象）**，先用 **localStorage（工作流草稿）+ 内存/mock（历史、资源）** 实现，
   待后端补齐对应 REST/WS 接口时**仅替换实现、不改 UI**。每个 mock 点在 UI 上以「演示数据」标注，避免误导。

> 决策记录（可在评审中调整）：
> - **D1 工作流存储**：P0 阶段工作流定义存 `localStorage`（前端本地草稿）。理由：后端无持久化，且原型的"列表/复制/导出"均可在本地完成。后端补 CRUD 后切换。
> - **D2 运行历史**：浏览器会话内用内存 store 记录本次会话发起过的运行（含已结束的事件快照）；跨会话历史待后端 `GET /runs`。
> - **D3 插件列表**：先内置一份与原型一致的静态插件清单（含 `test-plugin`），真实可运行的仅 `test-plugin`；待后端 `GET /plugins`。
> - **D4 取消运行**：按原型保持**禁用态**并注明「内核 AbortSignal 未实现」，不做假交互。
> - **D5 资源/调度**：P1 用 mock 展示，明确标注；待后端暴露 `getQueueStatus`。

---

## 4. 技术选型

| 关注点 | 选型 | 理由 |
| --- | --- | --- |
| 样式 | **Tailwind CSS v3 + 自定义 token** | 原型即 Tailwind 编写，迁移成本最低；token 已在 `theme.js` 定义好，直接搬进 `tailwind.config`。选 v3（生态稳定、与原型 `tailwind.config` 写法一致）。 |
| 设计 token | 迁移 `docs/prototype/assets/theme.js` → `tailwind.config.{js,ts}`；动效迁移 `console.css` → `src/index.css` | 颜色（brand/canvas/surface/ink/completed/running/queued/failed/skipped…）、圆角（card/ctrl/pill）、阴影、字体（JetBrains Mono）一比一还原。 |
| 图标 | **FontAwesome 6**（与原型一致） | 原型大量使用 `fa-solid` 图标，沿用可直接复用类名。可用 CDN（演示）或 `@fortawesome/react-fontawesome`（工程化，推荐后者）。 |
| **UI 组件库** | **不用重组件库（Ant Design / MUI）** | 见下方 §4.1 决策。重组件库的默认样式会与高度定制的 Control Room 主题打架，覆盖成本高于自研。 |
| 展示组件 | **Tailwind + 自研原子组件** | 承载定制视觉（StatusBadge / ProgressBar / DagNode 等），保住原型质感。 |
| 交互 / 可达性 | **无头库 Radix UI（或 Headless UI）** | 只提供行为、零样式，用 Tailwind 上妆。用于 Dialog / Drawer / Dropdown / Tabs / Tooltip / Popover —— 借力其焦点管理、键盘可达、点击外部关闭、定位，避免自己踩坑。 |
| DAG 画布 | **React Flow**（专用库，非通用组件库） | 编排器的可视化 DAG（拖拽建节点、连线、自动布局、缩放）是通用组件库覆盖不到的范畴，用专用库。运行详情的 DAG 状态视图可复用同一套渲染或用只读 SVG。 |
| 路由 | **react-router-dom 7**（已装） | 沿用。新增带侧边栏的布局路由 + 全屏路由（编排器/运行详情）。 |
| 服务端状态 | **TanStack Query**（推荐）或自研 hooks | 列表/详情类「请求-缓存-失效」用 Query；WebSocket 实时流单独用自定义 hook。若想零依赖，P0 也可仅用 hooks，后续再引入。 |
| WebSocket | 自研 `useWorkflowRun` hook + `WorkflowRunClient` 类 | 封装连接、自动重连、`event/done/error` 解析、单连接单任务约束、卸载清理（沉淀自 `Test.tsx`）。 |
| 客户端状态 | React 内置（Context + useReducer）起步；如复杂度上升再引 Zustand | 运行详情页的"事件 → DAG/日志聚合"是核心状态，用 reducer 清晰可测。 |
| 类型共享 | 从 `@monai-devops/core-engine` / `plugin-sdk` 复用类型 + 前端定义「序列化版」镜像类型 | 避免手抄；序列化差异（Error→{name,message}）单独建 `Serialized*` 类型。 |
| 表单/校验 | 轻量自研（JSON 校验、DAG 环检测、id 唯一性） | 原型交互简单，无需重表单库。 |
| 测试 | **Vitest + React Testing Library**；事件聚合 reducer 重点单测 | reducer 是纯函数，最高性价比的测试点。 |

> 待确认（评审决策）：是否引入 TanStack Query 与 Zustand。本计划默认 **P0 仅用 hooks + Context**，P1 视情况引入 Query。

### 4.1 关于 UI 组件库的决策

**结论：跳过通用 UI 组件库，采用「无头交互库 + 专用画布库 + Tailwind 自研」的分层方案。**

- **不用 Ant Design / MUI 等重组件库**，原因有三：
  1. **视觉打架**：本套设计是高度定制的 Control Room 主题（发光状态环 DAG 节点、流动连线、类终端日志流、映射内核语义的状态色）。重组件库需要大量样式覆盖，比手写更慢、更难维护；原型本身已用 Tailwind 纯手写验证可行。
  2. **通用组件不多**：全站复用组件仅 `StatusBadge` / `ProgressBar` / `Toast` / `Modal` / `Drawer` / `Tabs` / `Pill` / `EmptyState` / 下拉菜单 / `Select` / `Tooltip`。前半是纯展示，自研成本低；后半的难点是可达性与弹层定位，交给无头库。
  3. **最难的部分组件库帮不上**：编排器 DAG 画布是专用领域，需 React Flow，而非通用组件库。
- **无头库（Radix UI / Headless UI）** 负责 Dialog / Drawer / Dropdown / Tabs / Tooltip / Popover 的行为与可访问性，样式全部用 Tailwind。
- **React Flow** 负责编排器的可视化 DAG（阶段 1 依赖）。

> 待确认（评审决策）：无头库选 **Radix UI**（推荐，原子化、按需引入）还是 **Headless UI**（更轻、与 Tailwind 同源）。

---

## 5. 信息架构与路由

沿用原型导航（`assets/app.js` 中 `NAV`）：概览 / 工作流 / 运行 / 插件 / 资源，外加全屏的编排器与运行详情。

| 路由 | 页面 | 布局 | 数据源（P0） |
| --- | --- | --- | --- |
| `/` | 概览 Dashboard | 侧边栏布局 | mock + 会话内运行统计 |
| `/workflows` | 工作流列表 | 侧边栏布局 | localStorage |
| `/workflows/:id/edit`（与 `/workflows/new`） | 工作流编排器 | 全屏布局 | localStorage |
| `/runs` | 运行列表 | 侧边栏布局 | 会话内运行 store |
| `/runs/:runId` | **运行详情** ★ | 全屏布局 | **WebSocket 实时** |
| `/plugins` | 插件管理 + 单步试运行 | 侧边栏布局 | 静态清单 + ws 单步运行 |
| `/resources` | 资源与调度 | 侧边栏布局 | mock（标注） |

两种布局（对应原型）：

- **AppShell（侧边栏布局）**：左侧 `Sidebar`（导航 + 最近运行）+ 顶部 `Topbar`（env 标识、ws 连接状态 pill、新建工作流、头像）。对应 `renderSidebar` / `renderTopbar`。
- **FullscreenLayout（全屏布局）**：编排器、运行详情用，自带顶栏，无侧边栏（原型中这两页 `data-page` 为空，不注入 shell）。

---

## 6. 目录结构（建议）

```
apps/web/src/
├─ main.tsx                      # 已存在：BrowserRouter + basename
├─ App.tsx                       # 路由表（重写：布局路由 + 页面路由）
├─ index.css                     # 全局样式（替换模板；迁移 console.css 动效 + Tailwind 指令）
├─ config/
│  └─ env.ts                     # 已存在：apiBaseUrl / wsUrl / basename
├─ shared/
│  ├─ types/
│  │  ├─ workflow.ts             # WorkflowDefinition / Step / Condition（复用内核）
│  │  ├─ events.ts               # Serialized 生命周期事件 + 出站消息
│  │  └─ status.ts               # StepStatus/FailureKind/SkipReason + 派生 UI 状态
│  ├─ api/
│  │  ├─ http.ts                 # fetch 封装（基于 apiBaseUrl）
│  │  └─ workflow-run-client.ts  # WebSocket 客户端（沉淀自 Test.tsx）
│  ├─ data/                      # 数据仓库抽象（mock/localStorage，可替换为后端）
│  │  ├─ workflows.repo.ts       # D1 localStorage
│  │  ├─ runs.store.ts           # D2 会话内运行 store
│  │  ├─ plugins.repo.ts         # D3 静态插件清单
│  │  └─ resources.mock.ts       # D5 资源/队列 mock
│  ├─ hooks/
│  │  ├─ useWorkflowRun.ts       # 发起运行 + 订阅事件流
│  │  └─ useWsStatus.ts          # 连接状态（connected/reconnect/down）
│  └─ ui/                        # 设计系统原子组件（Tailwind 自研；弹层/tabs 基于 Radix 封装）
│     ├─ StatusBadge.tsx  Toast.tsx  Modal.tsx  Drawer.tsx   # Modal/Drawer 包 Radix Dialog
│     ├─ Tabs.tsx  Pill.tsx  ProgressBar.tsx  EmptyState.tsx  # Tabs 包 Radix Tabs
│     ├─ DropdownMenu.tsx  Tooltip.tsx  Select.tsx            # 包 Radix Menu/Tooltip/Select
│     └─ Sidebar.tsx  Topbar.tsx
├─ features/
│  ├─ dashboard/                 # 概览
│  ├─ workflows/                 # 列表 + 行菜单
│  ├─ editor/                    # 编排器（插件库 / DAG 画布 / 步骤属性 / DAG 校验）
│  ├─ runs/                      # 运行列表（筛选 + 进度条）
│  ├─ run-detail/                # ★ DAG 状态视图 + 事件日志流 + 步骤抽屉 + 事件聚合 reducer
│  ├─ plugins/                   # 插件列表 + 单步试运行
│  └─ resources/                 # 资源池 + 调度队列
└─ layouts/
   ├─ AppShell.tsx
   └─ FullscreenLayout.tsx
```

---

## 7. 数据层与契约（先于 UI 落地）

### 7.1 类型镜像（`shared/types`）

复用 `@monai-devops/core-engine` 的 `WorkflowDefinition / WorkflowStep / StepCondition`，并定义与
`serialize-workflow-event.ts` 输出对齐的「序列化版」类型：

```ts
interface SerializedError { name: string; message: string }

interface ExecutionResultSerialized {
  stepId: string;
  status: 'completed' | 'skipped' | 'failed';
  success: boolean;
  result?: unknown;
  pluginResult?: { success: boolean; message?: string; data?: unknown; code?: string };
  error?: SerializedError;
  failureKind?: 'plugin' | 'resource' | 'internal';
  skipReason?: 'condition_not_met' | 'dependency_failed' | 'workflow_aborted';
}
```

### 7.2 WebSocket 客户端（`workflow-run-client.ts`）

从 `Test.tsx` 的 `runWorkflowViaWebSocket` 抽象，职责：

- 建连 → `onopen` 发送 `{ type:'run', workflow }`；
- `onmessage` 解析 `event/done/error`，回调给订阅者；
- 暴露连接状态（`connected/reconnecting/down`，驱动顶栏 pill 与运行详情只读 banner）；
- 单连接单任务保护：运行中禁用重复提交；
- 卸载/页面切走时 `close()`。

### 7.3 事件聚合 reducer（运行详情核心，可单测）

输入「事件流」→ 输出「可渲染运行状态」：

```ts
interface RunState {
  runId: string;
  workflowName: string;
  steps: Record<string, StepView>;   // 由 step:* 事件驱动状态机
  edges: Edge[];                       // 由 dependsOn 推导
  logs: LogLine[];                     // plugin:log + 事件转写
  counts: { completed; running; queued; failed; skipped; total };
  status: 'running' | 'finished';
  finalResult?: WorkflowRunResultSerialized;
}
```

步骤状态机（事件 → 状态）：`step:queued`→`queued`、`step:start`→`running`、
`step:finished`→`result.status`（`completed`/`failed`/`skipped`）。
**这是整个前端最值得写单元测试的纯函数**：给定一串事件，断言最终 `RunState`。

---

## 8. 设计系统落地

1. **token 迁移**：`docs/prototype/assets/theme.js` 的 `theme.extend`（colors / fontFamily / borderRadius / boxShadow）整段搬入 `tailwind.config`。
2. **动效迁移**：`console.css` 中的 `live-dot`、`running-ring`（DAG 运行节点发光环）、`cursor-blink`（日志终端光标）、`edge-active`（流动连线）、`toast-in`、滚动条样式、`prefers-reduced-motion` 降级 → 进 `src/index.css`。
3. **原子组件**：`StatusBadge`（状态→图标+色，映射 `BADGE`/`META`/`ST` 表）、`ProgressBar`（运行进度分段条）、`Drawer`/`Modal`/`Toast`/`Tabs`/`Pill`/`EmptyState`。
4. **DAG 节点组件**：`<DagNode status>` 应用 `node-{status}` 发光环 class，承载原型签名视觉。
5. **字体**：引入 JetBrains Mono（runId / 日志 / JSON 用等宽），正文用系统字体栈（同 `console.css`）。

---

## 9. 分阶段开发计划（里程碑 + 验收）

### 阶段 0 · 基础设施（地基）

> 目标：把脚手架升级为「能按设计系统写页面」的工程底座。

- [ ] 安装并配置 Tailwind v3；迁移 `theme.js` token 到 `tailwind.config`。
- [ ] 重写 `src/index.css`：Tailwind 指令 + 迁移 `console.css` 动效与滚动条。
- [ ] 引入 FontAwesome（推荐 React 组件方式）与 JetBrains Mono。
- [ ] 引入无头交互库（**Radix UI** 或 Headless UI），封装 `Modal`/`Drawer`/`Tabs`/`DropdownMenu`/`Tooltip`/`Select` 等原子组件（Tailwind 上妆）。
- [ ] 搭建 `shared/types`、`shared/api`（http + ws client）、`shared/data` 抽象骨架。
- [ ] 实现 `AppShell`（Sidebar + Topbar）与 `FullscreenLayout`；重写 `App.tsx` 路由表（见 §5）。
- **验收**：`pnpm --filter web dev` 启动，导航骨架可见，token/动效生效；`lint`/`build` 通过。

### 阶段 1 · 核心闭环（P0，全部接真数据）★

> 目标：跑通「编排 → 运行 → 观测」主线，**完全基于现有后端 WebSocket**。

- [ ] **工作流编排器** `/workflows/:id/edit`
  - 引入 **React Flow** 承载 DAG 画布（拖拽建节点、连线、自动布局、缩放）。
  - 三栏：插件库（搜索/拖入）/ DAG 画布（React Flow 节点 + 连线）/ 步骤属性（id、name、plugin、dependsOn、priority、resourceType、condition、config JSON）。
  - 运行级配置：并行数、failFast、默认优先级。
  - **DAG 校验**：id 唯一性 + 环检测（对应内核 `WorkflowValidationError`），有环禁用「运行」。
  - config JSON 实时合法性校验。
  - 「运行」→ 组装 `WorkflowDefinition` → 经 ws client 发起 → 跳转 `/runs/:runId`。
- [ ] **运行详情** `/runs/:runId` ★（平台核心）
  - 左：DAG 状态视图（事件驱动的节点状态机 + 发光环 + 流动连线 + 图例）。
  - 右：事件/日志流（全部/仅日志/仅错误过滤、自动滚动、暂停、导出、终端光标）。
  - 顶：运行摘要（runId 复制、状态、并行/failFast、计时、分段进度 + 状态计数）。
  - 步骤抽屉：点节点下钻，按 `failed`/`skipped`/`queued`/`running` 分别渲染（失败展示 `pluginResult` + `failureKind`，跳过展示 `skipReason`，排队展示等待资源并引导去资源页）。
  - ws 断连 → 顶部只读 banner + 暂停实时刷新（对应 `ws-change`）。
  - 取消运行：**禁用态 + tooltip**（D4）。
- [ ] **运行列表** `/runs`
  - 表格（状态/工作流/runId/开始时间/分段进度），进行中置顶并实时刷新。
  - 状态筛选、工作流筛选、搜索 runId/工作流。
  - 数据源：会话内运行 store（D2）。
- **验收（端到端）**：在编排器编一个 `test-plugin` 工作流 → 点运行 → 运行详情实时出现
  `workflow:start → step:start → plugin:log → step:finished → … → workflow:finished` 的真实事件流，
  DAG 节点随事件变色，日志流追加；运行结束后该运行出现在运行列表。**事件聚合 reducer 单测通过。**

### 阶段 2 · 管理与观测增强（P1）

- [ ] **工作流列表** `/workflows`：表格 + 搜索 + 一键运行 + 进编排器 + 行菜单（复制/导出 JSON/删除）+ 空状态 + 分页。数据源 localStorage（D1）。
- [ ] **插件管理** `/plugins`：插件列表（静态清单 D3）+ 详情 + **单步试运行**（填 config，经 ws 跑单步，展示 `PluginResult` 与 `plugin:log`；演示返回成功/业务失败/未注册三态）。
- [ ] **资源与调度** `/resources`：资源池占用条 + 调度队列表 + 调度器状态卡。mock 数据并标注（D5）。
- **验收**：三页符合原型交互；mock 点均有「演示数据」标识；工作流可在列表↔编排器间往返且本地持久化。

### 阶段 3 · 概览与打磨（V2 / P2）

- [ ] **概览 Dashboard** `/`：KPI 卡（进行中/成功率/排队/插件数）+ 趋势图（SVG）+ 资源占用快照 + 近期运行表，卡片下钻到对应页。统计来自会话 store + mock。
- [ ] 全局打磨：Toast/确认弹窗体系、键盘可达性、`prefers-reduced-motion`、响应式与空/错/加载态、错误边界。
- [ ] 文档：更新 `apps/web/README`（环境变量、启动、与后端联调说明）。
- **验收**：7 视图全部可点击演示、视觉与原型一致；`lint`/`build`/`test` 全绿。

---

## 10. 与后端的协作清单（建议后端补齐的接口）

按对前端价值排序，便于推动后端排期；补齐后前端**仅替换 `shared/data` 实现**：

1. `GET /plugins` —— 插件注册表（name/version/description），替换 D3 静态清单。
2. `GET /workflows` · `POST /workflows` · `GET/PUT/DELETE /workflows/:id` —— 工作流 CRUD，替换 D1 localStorage。
3. `GET /runs` · `GET /runs/:runId` —— 运行历史与详情（含已结束运行的事件快照），替换 D2 会话 store。
4. `GET /resources/queue` —— 暴露内核 `getQueueStatus`，替换 D5 mock。
5. 运行取消（内核 AbortSignal）—— 解除 D4 禁用态。
6. WebSocket 支持「订阅已存在 runId」/ 多任务 —— 解除单连接单任务限制，支撑刷新页面后重连观测。

---

## 11. 风险与未决问题

- **R1 后端能力差距**：原型 7 视图中仅「编排器→运行→运行详情」可全真；其余依赖 mock/本地存储。需评审确认是否接受「P0 真实 + P1/P2 mock 兜底」的策略（§3）。
- **R2 单连接单任务**：刷新运行详情页会断开实时流且无法重连观测（后端无「按 runId 订阅」）。P0 内：刷新后展示该运行的会话内事件快照（若有），并提示「实时流已结束」。
- **R3 插件真实性**：除 `test-plugin` 外，插件库/属性面板中的 `build/test/deploy/...` 为演示项，真实发起会触发 `PLUGIN_NOT_FOUND`。编排器需对「未注册插件」给出明确提示，运行前可校验。
- **R4 Tailwind 版本**：默认 v3；若团队倾向 v4，token 迁移写法需调整（评审决定）。
- **R5 状态管理引入时机**：默认 hooks+Context 起步，复杂度上升后再引 Zustand/Query（评审决定是否提前引入）。

---

## 12. 建议执行顺序小结

```
阶段0 地基(Tailwind+token+布局+数据层骨架)
  → 阶段1 编排器 → 运行详情★ → 运行列表  [真实闭环, 验收=端到端事件流]
  → 阶段2 工作流列表 → 插件 → 资源        [P1, mock/本地兜底]
  → 阶段3 概览 → 全局打磨 → 文档          [V2/P2]
```

核心原则：**先打通基于现有后端的真实闭环（编排→运行→观测），再用可替换的数据抽象补全原型其余视图**，
确保每一步都可演示、可验收，且后端补齐接口时 UI 零改动。
