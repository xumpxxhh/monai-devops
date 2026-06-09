# monai-devops

MONAI DevOps 是一个基于 **插件化工作流编排** 的 DevOps 平台。内核负责 DAG 执行、任务调度、资源池管理与可观测性；业务逻辑以插件形式扩展，通过 NestJS 服务端与 React 前端提供 HTTP / WebSocket 集成与调试界面。

## 特性

- **DAG 工作流**：基于 `dependsOn` 的有向无环图，支持并行步骤、条件跳过、failFast
- **插件体系**：契约由 `@monai-devops/plugin-sdk` 定义，内核 `@monai-devops/core-engine` 只依赖 SDK、不反向耦合
- **资源调度**：按 `resourceType` 维护独立队列，资源不足时挂起等待而非立即失败
- **可观测性**：`WorkflowObserver` 推送 `workflow:*`、`step:*`、`plugin:log` 等结构化生命周期事件
- **Monorepo**：pnpm workspace + Turborepo，packages / apps / plugins 分层清晰

## 架构

```mermaid
flowchart TB
  subgraph apps [应用层]
    WEB[apps/web<br/>React + Vite]
    SRV[apps/server<br/>NestJS]
  end

  subgraph packages [核心包]
    CE[@monai-devops/core-engine]
    SDK[@monai-devops/plugin-sdk]
  end

  subgraph plugins [插件]
    TP[test-plugin]
  end

  WEB -->|HTTP / WebSocket| SRV
  SRV --> CE
  CE --> SDK
  TP --> SDK
  SRV --> TP
  CE -->|pluginExecutor| TP
```

**依赖方向**：`apps/*` → `core-engine` → `plugin-sdk`；插件实现只需依赖 SDK。

## 仓库结构

```
monai-devops/
├── apps/
│   ├── server/          # NestJS 后端：工作流 HTTP / WebSocket API
│   └── web/             # React 前端：集成测试与实时日志页面
├── packages/
│   ├── core-engine/     # 工作流编排内核（详见 packages/core-engine/README.md）
│   └── plugin-sdk/      # 插件契约与辅助工具
├── plugins/
│   └── test-plugin/     # 示例插件（单元 / 集成 / E2E 测试模拟）
├── docs/plans/          # 设计规划文档
├── pnpm-workspace.yaml
└── turbo.json
```

## 环境要求

- **Node.js** ≥ 20
- **pnpm** 10.x（见根目录 `packageManager` 字段）

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置环境变量

**服务端**（在 `apps/server/` 下创建 `.env` 或 `.env.local`）：

| 变量 | 必填 | 说明 | 示例 |
|------|------|------|------|
| `GLOBAL_API_PREFIX` | 是 | 全局 API 前缀 | `api/v1/devops` |
| `PORT` | 否 | 监听端口，默认 `3000` | `3000` |

**前端**（在 `apps/web/` 下创建 `.env` 或 `.env.local`，变量前缀为 `DEVOPS_`）：

| 变量 | 必填 | 说明 | 示例 |
|------|------|------|------|
| `DEVOPS_API_BASE_URL` | WebSocket 测试必填 | 后端 API 基地址（含前缀） | `http://localhost:3000/api/v1/devops` |
| `DEVOPS_BASE_PATH` | 否 | React Router basename，默认 `/` | `/` |

### 3. 启动开发环境

```bash
# 同时启动 server + web（需先 build 依赖包）
pnpm dev

# 或分别启动
pnpm dev:server   # NestJS，默认 http://localhost:3000
pnpm dev:web      # Vite，默认 http://localhost:5173
```

### 4. 验证集成

- **HTTP**：`GET http://localhost:3000/api/v1/devops/test-devops`（路径中的前缀与 `GLOBAL_API_PREFIX` 一致）
- **前端**：访问 `/test` 页面，运行「Core Engine 集成测试」或 WebSocket 实时日志测试
- **WebSocket**：连接 `ws://localhost:3000/api/v1/devops/test-devops/ws`，发送 `{ "type": "run", "workflow": { ... } }`

## 核心包

### @monai-devops/core-engine

工作流编排内核，通过 `createEngine()` 串联插件管理、DAG 执行器、任务调度器与资源池。

```ts
import { createEngine, WorkflowContextKeys } from '@monai-devops/core-engine';
import { createPlugin, getContext } from '@monai-devops/plugin-sdk';

const echoPlugin = createPlugin({
  name: 'echo',
  version: '1.0.0',
  execute: async (config, ctx) => {
    const stepId = getContext<string>(ctx, WorkflowContextKeys.stepId);
    return { success: true, data: { stepId, value: config.value } };
  },
});

const engine = createEngine({ plugins: [echoPlugin], maxParallelSteps: 2 });

const run = await engine.runWorkflow({
  id: 'demo',
  name: 'Demo Pipeline',
  steps: [
    { id: 'a', name: 'A', plugin: 'echo', config: { value: 1 } },
    { id: 'b', name: 'B', plugin: 'echo', config: { value: 2 }, dependsOn: ['a'] },
  ],
});

engine.destroy();
```

完整 API、错误模型、可观测性事件说明见 [packages/core-engine/README.md](./packages/core-engine/README.md)。

### @monai-devops/plugin-sdk

插件开发者只需依赖此包：

| 导出 | 用途 |
|------|------|
| `createPlugin` | 创建插件定义，可选编排 `beforeExecute` / `afterExecute` / `onError` 钩子 |
| `getConfig` / `getContext` | 读取步骤配置与运行时上下文 |
| `getLogger` | 获取步骤级日志器（经 observer 发出 `plugin:log` 事件） |
| `PluginFailureCodes` | 插件失败错误码常量 |

插件层约定：**业务失败返回 `{ success: false }`，不 throw**。

## 编写插件

在 `plugins/` 下新建包，依赖 `@monai-devops/plugin-sdk`，参考 `plugins/test-plugin`：

```ts
import { createPlugin, getConfig, getLogger } from '@monai-devops/plugin-sdk';

export const myPlugin = createPlugin({
  name: 'my-plugin',
  version: '1.0.0',
  execute: async (config, context) => {
    const log = getLogger(context);
    const type = getConfig<string>(config, 'type');
    log.info('开始执行', { type });
    return { success: true, message: '完成' };
  },
});
```

在服务端或脚本中通过 `createEngine({ plugins: [myPlugin] })` 注册即可。

## 服务端 API（test-devops）

当前 `apps/server` 提供用于验证 core-engine 闭环的测试模块：

| 方式 | 路径 | 说明 |
|------|------|------|
| HTTP GET | `/{GLOBAL_API_PREFIX}/test-devops` | 运行内置集成工作流，一次性返回结果 |
| WebSocket | `/{GLOBAL_API_PREFIX}/test-devops/ws` | 接收 `{ type: "run", workflow: WorkflowDefinition }`，实时推送事件与最终结果 |

WebSocket 出站消息类型：

- `{ type: "event", event: ... }` — 工作流生命周期事件（含 `plugin:log`）
- `{ type: "done", result: ... }` — 执行完成
- `{ type: "error", message: ... }` — 错误

## 常用命令

在仓库根目录执行：

| 命令 | 说明 |
|------|------|
| `pnpm build` | 构建全部包与应用 |
| `pnpm dev` | 开发模式（server + web） |
| `pnpm dev:server` | 仅启动 NestJS |
| `pnpm dev:web` | 仅启动 Vite |
| `pnpm test` | 运行各包测试（turbo 编排） |
| `pnpm check-types` | 全仓库 TypeScript 类型检查 |
| `pnpm lint` / `pnpm lint:fix` | ESLint |
| `pnpm format` / `pnpm format:check` | Prettier |

单包示例：

```bash
pnpm --filter @monai-devops/core-engine test
pnpm --filter server test:e2e
```

## 技术栈

| 层级 | 技术 |
|------|------|
| 包管理 / 构建 | pnpm workspace、Turborepo |
| 内核 | TypeScript（ESM）、自研 DAG 执行器 |
| 后端 | NestJS 11、WebSocket（ws） |
| 前端 | React 19、Vite 8、React Router 7 |
| 质量 | ESLint 9、Prettier、Jest / Node test runner |

## 后续规划

- 完善生产级 HTTP API 与工作流持久化
- 表达式级步骤 `condition`（当前为结构化条件）
- 步骤级 `AbortSignal` 取消进行中的插件执行

更多设计细节见 `docs/plans/`。
