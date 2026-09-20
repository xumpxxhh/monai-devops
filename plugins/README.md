# 插件开发指南

本文档面向 monai-devops 插件开发者，说明如何在 `plugins/` 目录下创建、注册、调试插件，以及插件与平台各层（SDK、引擎、服务端、前端）的协作方式。

## 目录

- [架构概览](#架构概览)
- [快速开始](#快速开始)
- [插件包结构](#插件包结构)
- [核心概念](#核心概念)
- [编写插件](#编写插件)
- [注册与同步](#注册与同步)
- [构建与验证](#构建与验证)
- [调试与试运行](#调试与试运行)
- [在工作流中使用](#在工作流中使用)
- [内置示例插件](#内置示例插件)
- [最佳实践](#最佳实践)
- [常见问题](#常见问题)
- [相关文档](#相关文档)

---

## 架构概览

monai-devops 采用**插件化工作流编排**架构：业务逻辑以独立 npm 包形式存在于 `plugins/`，由 `@monai-devops/core-engine` 在运行时调度执行。

```
┌─────────────────────────────────────────────────────────────┐
│  apps/web          插件管理页、工作流编排、实时日志展示        │
└───────────────────────────┬─────────────────────────────────┘
                            │ HTTP / SSE / WebSocket
┌───────────────────────────▼─────────────────────────────────┐
│  apps/server       NestJS API、插件注册表、Engine 生命周期     │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│  @monai-devops/core-engine   DAG 执行、资源调度、可观测性     │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│  @monai-devops/plugin-sdk    插件契约、createPlugin、工具函数  │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│  plugins/*         你的插件实现（只依赖 plugin-sdk）          │
└─────────────────────────────────────────────────────────────┘
```

**依赖方向（必须遵守）**：

| 包            | 可依赖                                           |
| ------------- | ------------------------------------------------ |
| `plugins/*`   | `@monai-devops/plugin-sdk`（及插件自身业务依赖） |
| `core-engine` | `plugin-sdk`                                     |
| `apps/server` | `core-engine` + 已注册的 `plugins/*`             |

插件**不应**依赖 `core-engine` 或 `apps/server`，以保持可独立构建、测试与发布。

---

## 快速开始

### 1. 脚手架创建插件

在仓库根目录执行：

```bash
pnpm create:plugin <plugin-name>
```

示例：

```bash
pnpm create:plugin deploy-plugin
```

该命令会：

1. 在 `plugins/deploy-plugin/` 创建标准包结构（`package.json`、`tsconfig.json`、`src/index.ts`）
2. 将插件名追加到 `apps/server/plugins.config.json`
3. 自动运行 `pnpm sync:plugins`，更新服务端注册表与依赖

**命名规则**：小写 kebab-case，仅允许字母、数字和短横线，例如 `model-call-plugin`。

### 2. 安装依赖并构建

```bash
pnpm install
pnpm --filter @monai-devops/deploy-plugin check-types
pnpm --filter @monai-devops/deploy-plugin build
pnpm --filter server build
```

### 3. 启动开发环境

```bash
pnpm dev
```

访问前端「插件管理」页面，选择新插件进行配置与试运行。

---

## 插件包结构

每个插件是一个独立的 pnpm workspace 包，命名空间为 `@monai-devops/<plugin-name>`：

```
plugins/my-plugin/
├── package.json       # 包元数据，依赖 @monai-devops/plugin-sdk
├── tsconfig.json      # 继承 plugins/tsconfig.base.json
└── src/
    └── index.ts       # 插件入口：export const myPlugin = createPlugin({...})
```

`package.json` 关键字段：

| 字段             | 说明                                                                    |
| ---------------- | ----------------------------------------------------------------------- |
| `name`           | `@monai-devops/<plugin-name>`，与服务端 workspace 依赖一致              |
| `type`           | `"module"`（ESM）                                                       |
| `main` / `types` | 指向 `dist/` 编译产物                                                   |
| `dependencies`   | 生产依赖只需 `@monai-devops/plugin-sdk`；业务库（如 LangChain）按需添加 |

`tsconfig.json` 继承 `plugins/tsconfig.base.json`，输出到 `dist/`：

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src/**/*"]
}
```

---

## 核心概念

### PluginDefinition

通过 `createPlugin()` 创建的插件定义，包含：

| 字段           | 必填 | 说明                                               |
| -------------- | ---- | -------------------------------------------------- |
| `name`         | 是   | 全局唯一插件名；工作流步骤的 `plugin` 字段引用此值 |
| `version`      | 是   | 语义化版本                                         |
| `description`  | 否   | 展示用描述                                         |
| `configSchema` | 推荐 | Zod schema，声明步骤配置结构                       |
| `resultSchema` | 按需 | Zod schema，**只描述** `PluginResult.data` 的结构  |
| `execute`      | 是   | 插件执行函数                                       |
| `hooks`        | 否   | 生命周期钩子                                       |

### PluginConfig

来自工作流步骤 JSON 的 `config` 字段，类型为 `Record<string, unknown>`。

- 声明了 `configSchema` 时，`createPlugin` 会在调用 `execute` 前自动校验并收窄类型
- 校验失败返回 `{ success: false, code: 'PLUGIN_CONFIG_INVALID', message }`，不调用 `execute`
- 常见引擎约定：`resourceType?: string` 用于声明所需资源类型（在 schema 中显式声明即可）

### PluginResult

插件执行结果。**业务失败应返回此结构，不要 throw**：

```ts
// 成功
return {
  success: true,
  message: '完成',
  data: { artifact: 'path/to/out' },
};

// 业务失败
return {
  success: false,
  message: '参数 type 无效',
};
```

| 字段      | 说明                                                    |
| --------- | ------------------------------------------------------- |
| `success` | `true` 成功，`false` 失败                               |
| `message` | 人类可读说明                                            |
| `data`    | 成功时的业务数据，写入步骤 `result`，供下游 `$ref` 引用 |
| `code`    | 失败错误码，通常由引擎/SDK 填充，插件作者一般无需设置   |

### resultSchema

可选 Zod schema，**只描述 `data` 字段**（不是整个 `PluginResult`）。

用途：

- 前端编排时展示「引用上游字段」树
- 工作流保存/启动前校验：未声明 `resultSchema` 的插件**不能**被其他步骤的 `$ref` 引用

注意：`createPlugin` 原样透传 `resultSchema`，**不做运行时校验**，声明与实际返回是否一致由插件作者保证。

### PluginContext

单次 `execute` 的运行时上下文。典型插件只需：

- `getLogger(context)` — 步骤级日志
- `getAbortSignal(context)` / `throwIfAborted(context)` / `sleep(ms, context)` — 协作式取消

若需读取编排字段（如 `stepId`、`runId`），使用 `getContext(context, key)`，键名约定见 [core-engine README](../packages/core-engine/README.md#executioncontext-与-workflowcontextkeys)。

---

## 编写插件

### 最小示例

参考 `plugins/test-plugin`：

```ts
import { createPlugin, getLogger, z } from '@monai-devops/plugin-sdk';
import type { PluginContext, PluginResult } from '@monai-devops/plugin-sdk';

const configSchema = z.object({
  type: z.enum(['unit', 'integration', 'e2e']),
});

async function executeTestPlugin(
  config: z.infer<typeof configSchema>,
  context: PluginContext,
): Promise<PluginResult> {
  const log = getLogger(context);
  log.info('开始执行', { type: config.type });

  return {
    success: true,
    message: `${config.type} 执行成功`,
    data: { type: config.type, message: `${config.type} 执行成功` },
  };
}

export const testPlugin = createPlugin({
  name: 'test-plugin',
  version: '1.0.0',
  description: '测试插件',
  configSchema,
  resultSchema: z.object({
    type: z.enum(['unit', 'integration', 'e2e']),
    message: z.string(),
  }),
  execute: executeTestPlugin,
});

export default testPlugin;
```

### 使用 configSchema（推荐）

```ts
const configSchema = z.object({
  branch: z.string().default('main'),
  timeout: z.number().int().positive().default(300),
  resourceType: z.string().optional(), // 需要资源池时声明
});

// execute 的 config 参数自动推断为 z.infer<typeof configSchema>
```

`z` 从 `@monai-devops/plugin-sdk` re-export，插件无需单独安装 zod。

### 步骤日志

使用 `getLogger(context)`，**不要使用 `console.log`**：

```ts
const log = getLogger(context);

log.debug('调试信息', { detail: 1 });
log.info('阶段完成');
log.warn('资源紧张');
log.error('非致命告警');
log.append('[build] compiling...\n', 'stdout'); // stream: 'stdout' | 'stderr'
```

日志经 core-engine 发出 `plugin:log` 事件，服务端通过 SSE/WebSocket 推送给前端实时展示。

### 协作式取消

工作流硬取消或暂停（`abortInFlight: true`）时，引擎向 context 注入 `AbortSignal`：

```ts
import {
  getAbortSignal,
  throwIfAborted,
  sleep,
  PluginCancelledError,
} from '@monai-devops/plugin-sdk';

// 在循环或长任务中主动检查
for await (const chunk of stream) {
  throwIfAborted(context);
  // ...
}

// 可中断等待（替代 setTimeout）
await sleep(3000, context);

// 传给支持 abort 的底层 API
const signal = getAbortSignal(context);
await fetch(url, { signal });
```

`throwIfAborted` 抛出 `PluginCancelledError`，经 SDK 转为 `PLUGIN_CANCELLED` 结果，步骤记为 `SKIPPED`（非 `FAILED`）。

### 生命周期钩子

```ts
hooks: {
  beforeExecute: async (config, context) => {
    // execute 之前
  },
  afterExecute: async (result, config, context) => {
    // execute 正常返回后（含 { success: false } 业务失败）
  },
  onError: async (error, config, context) => {
    // beforeExecute 或 execute 抛异常时
  },
}
```

执行顺序：

```
beforeExecute → execute → afterExecute
                ↓ throw
              onError → return { success: false, message }
```

注意：

- `return { success: false }` **不**触发 `onError`，仍会调用 `afterExecute`
- 有 hooks 时，异常会被捕获并转为 `{ success: false }`，不会穿透到 executor

### 调用外部 API / 读取环境变量

参考 `plugins/model-call-plugin`：

```ts
const configSchema = z.object({
  message: z.string().default('Hello'),
  apiKey: z.string().min(1).optional(),
});

async function execute(config, context) {
  const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { success: false, message: '缺少 apiKey' };
  }
  // ...
}
```

敏感信息优先通过环境变量注入，config 中提供可选覆盖。

### 流式输出

参考 `plugins/model-call-plugin`，使用 `log.append` 逐块输出：

```ts
for await (const chunk of response) {
  throwIfAborted(context);
  log.append(chunk.content.toString(), 'stdout');
  fullResponse += chunk.content.toString();
}

return { success: true, data: fullResponse };
```

### 复杂 resultSchema

参考 `plugins/muti-result-plugin`，用嵌套 Zod 对象描述多层 `data` 结构，供前端字段引用树展示。

---

## 注册与同步

插件不会自动被服务端加载，需完成以下注册流程。

### 配置文件

`apps/server/plugins.config.json` 列出要启用的插件（目录名）：

```json
{
  "plugins": ["test-plugin", "model-call-plugin", "my-new-plugin"]
}
```

`pnpm create:plugin` 会自动追加；手动新建插件时需自行添加。

### 同步注册表

```bash
pnpm sync:plugins
```

该命令会：

1. 校验 `plugins.config.json` 中每个插件目录存在
2. 生成 `apps/server/src/plugins/plugin-registry.ts`（**自动生成，勿手改**）
3. 同步 `apps/server/package.json` 中的 `workspace:*` 依赖

生成的注册表示例：

```ts
// AUTO-GENERATED — 请勿手工编辑，运行 pnpm sync:plugins 更新

import testPlugin from '@monai-devops/test-plugin';
import myNewPlugin from '@monai-devops/my-new-plugin';

export const registeredPlugins = [testPlugin, myNewPlugin];
```

`EngineService` 在启动时通过 `createEngine({ plugins: registeredPlugins })` 加载全部插件。

### 手动注册流程（不用脚手架时）

1. 在 `plugins/<name>/` 创建包（参考 `test-plugin`）
2. 将 `<name>` 加入 `apps/server/plugins.config.json`
3. 运行 `pnpm sync:plugins`
4. 运行 `pnpm install`
5. 构建插件与服务端

---

## 构建与验证

### 单插件命令

```bash
# 类型检查
pnpm --filter @monai-devops/<plugin-name> check-types

# 编译
pnpm --filter @monai-devops/<plugin-name> build

# Lint / 格式化
pnpm --filter @monai-devops/<plugin-name> lint
pnpm --filter @monai-devops/<plugin-name> format
```

### 全仓库

```bash
pnpm build          # 构建全部包（含插件）
pnpm check-types    # 全仓库类型检查
pnpm test           # 运行各包测试
```

### SDK 单元测试

插件契约行为由 `@monai-devops/plugin-sdk` 与 `core-engine` 测试覆盖：

```bash
pnpm --filter @monai-devops/plugin-sdk test
pnpm --filter @monai-devops/core-engine test
```

---

## 调试与试运行

### 前端插件管理页

启动 `pnpm dev` 后，访问 Web 端「插件管理」页面：

1. 左侧选择已注册插件
2. 根据 `configSchema` 自动渲染配置表单
3. 点击「试运行」，通过 SSE 实时查看日志与最终结果

### HTTP API

服务端提供以下插件相关接口（路径前缀为 `GLOBAL_API_PREFIX`，默认 `api/v1/devops`）：

| 方法   | 路径                           | 说明                             |
| ------ | ------------------------------ | -------------------------------- |
| `GET`  | `/plugins`                     | 列出已注册插件                   |
| `GET`  | `/plugins/:name`               | 获取单个插件信息                 |
| `GET`  | `/plugins/config-schemas`      | 全部插件 config JSON Schema      |
| `GET`  | `/plugins/:name/config-schema` | 单个插件 config JSON Schema      |
| `GET`  | `/plugins/result-schemas`      | 全部插件 result JSON Schema      |
| `GET`  | `/plugins/:name/result-schema` | 单个插件 result JSON Schema      |
| `POST` | `/plugins/:name/dry-run`       | SSE 试运行（body: `{ config }`） |

试运行限制：config 中不能包含上游步骤引用（`$ref`），需使用完整工作流测试引用场景。

### 在工作流中集成测试

通过 WebSocket 或 HTTP 测试模块发送完整 `WorkflowDefinition`，参见根目录 [README](../README.md#服务端-api-test-devops)。

---

## 在工作流中使用

工作流步骤通过 `plugin` 字段引用插件 `name`：

```json
{
  "id": "run-tests",
  "name": "运行测试",
  "plugin": "test-plugin",
  "config": {
    "type": "unit"
  }
}
```

带依赖与字段引用：

```json
{
  "id": "print-result",
  "name": "打印结果",
  "plugin": "print-plugin",
  "dependsOn": ["run-tests"],
  "config": {
    "data": { "$ref": "run-tests.data" }
  }
}
```

被 `$ref` 引用的插件**必须**声明 `resultSchema`。

需要资源池时，在 config 中声明 `resourceType`：

```json
{
  "config": {
    "type": "integration",
    "resourceType": "runner"
  }
}
```

---

## 内置示例插件

| 插件                 | 说明                   | 学习要点                                   |
| -------------------- | ---------------------- | ------------------------------------------ |
| `test-plugin`        | 模拟单元/集成/E2E 测试 | 基础结构、日志、`sleep`、取消信号          |
| `print-plugin`       | 将任意数据打印到日志   | `z.any()` config、安全序列化、`log.append` |
| `model-call-plugin`  | 调用大模型并流式输出   | 环境变量、AbortSignal、流式 `append`       |
| `muti-result-plugin` | 生成多层嵌套结果       | 复杂 `resultSchema`、前端字段树            |
| `embedding-plugin`   | Embedding 调用（示例） | 第三方 SDK 集成、API Key 配置              |
| `git-checkout-plugin` | 克隆仓库到 workspaceDir | `child_process` + 取消信号 + 流式日志     |
| `shell-exec-plugin` | 工作区内执行命令         | cwd 逃逸校验、超时与取消；可选 `sandbox: docker` |
| `file-inject-plugin` | 按相对路径写入文件       | `workspaceDir` + 路径逃逸校验              |

建议从 `test-plugin` 入手，再按需参考其他插件。

---

## 最佳实践

1. **业务失败用 Result，不用 throw** — 便于 executor 统一归类；仅取消场景可抛出 `PluginCancelledError`
2. **用 `configSchema` 声明配置** — 编译期类型安全 + 运行时校验 + 前端自动生成表单
3. **需要被下游引用时声明 `resultSchema`** — 只描述 `data`；结构应与实际返回一致
4. **日志用 `getLogger`** — 便于平台聚合、实时推送与持久化
5. **长任务响应取消** — 在 `await` 前后调用 `throwIfAborted`，或将 `signal` 传给支持 abort 的 API
6. **插件包只 production 依赖 SDK** — 不依赖 `core-engine`，保持独立可测
7. **`name` 与目录名、包名保持一致** — `plugins/foo-plugin` → `@monai-devops/foo-plugin` → `name: 'foo-plugin'`
8. **敏感配置走环境变量** — config 仅提供可选覆盖，不要把密钥写进工作流 JSON
9. **修改注册列表后运行 `pnpm sync:plugins`** — 避免手改 `plugin-registry.ts`
10. **构建后再启动服务端** — 服务端 import 的是 `dist/` 产物

---

## 常见问题

### 插件列表为空 / 插件不存在

- 确认插件名已写入 `apps/server/plugins.config.json`
- 运行 `pnpm sync:plugins && pnpm install`
- 确认插件已 `pnpm --filter @monai-devops/<name> build`
- 重启 server

### 前端配置表单不显示

- 确认插件声明了 `configSchema`
- 检查 `GET /plugins/:name/config-schema` 是否返回 JSON Schema

### 下游无法引用本插件输出

- 确认声明了 `resultSchema`，且结构与 `data` 实际返回一致
- 工作流校验会在保存/启动时检查 `$ref` 来源是否有 `resultSchema`

### 试运行报「不支持 $ref」

- 试运行是单插件隔离执行，不含上游步骤结果
- 去掉 config 中的 `$ref`，或改用完整工作流运行

### TypeScript 找不到插件模块

- 先 `pnpm install` 链接 workspace
- 确认 `apps/server/package.json` 中有 `"@monai-devops/<name>": "workspace:*"`（由 `sync:plugins` 维护）

---

## 相关文档

- [@monai-devops/plugin-sdk README](../packages/plugin-sdk/README.md) — SDK API 详细说明
- [@monai-devops/core-engine README](../packages/core-engine/README.md) — DAG 执行、资源调度、可观测性事件
- [根目录 README](../README.md) — Monorepo 快速开始与整体架构
- [plugin-sdk 设计规划](../docs/plans/plugin-sdk.md) — 日志等能力的设计备忘
