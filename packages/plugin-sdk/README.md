# plugin-sdk

`@monai-devops/plugin-sdk` 定义 monai-devops **插件契约与开发辅助 API**。插件实现只需依赖本包；编排、调度、资源池由 [`core-engine`](../core-engine) 负责，依赖方向为 **core-engine → plugin-sdk**，本包不反向耦合引擎。

## 职责边界

| 关注点                                           | plugin-sdk | core-engine                        |
| ------------------------------------------------ | ---------- | ---------------------------------- |
| 插件类型（Config / Context / Result）            | ✓          | 扩展 `ExecutionContext`            |
| `createPlugin`、生命周期钩子                     | ✓          | —                                  |
| 步骤级日志 API                                   | ✓          | 注入 logger、发出 `plugin:log`     |
| DAG 执行、资源调度                               | —          | ✓                                  |
| `WorkflowContextKeys`（编排字段名，引擎/测试用） | —          | ✓（re-export `PluginContextKeys`） |

## 核心类型

### PluginManifest

插件注册元数据，由 `createPlugin` 填写：

| 字段          | 必填 | 说明                                          |
| ------------- | ---- | --------------------------------------------- |
| `name`        | 是   | 全局唯一插件名，工作流 `step.plugin` 引用此值 |
| `version`     | 是   | 语义化版本字符串                              |
| `description` | 否   | 展示用描述                                    |

### PluginConfig

单次 `execute` 的入参，来自工作流步骤的 `config` 字段，索引签名 `[key: string]: unknown`。推荐用 `getConfig(config, 'key')` 读取。

常见约定（由引擎解释，非 SDK 强制）：

- `resourceType?: string` — 声明所需资源类型，由 engine 自动分配/释放

### PluginContext

单次 `execute` 的运行时上下文，索引签名。引擎可在步骤执行期注入扩展字段；**典型插件只需 `getLogger(context)`**，业务入参从 `getConfig` 读取即可（见 [`plugins/test-plugin`](../../plugins/test-plugin)）。若将来确需读取编排字段，用 `getContext(context, 'stepId')` 等字符串键，键名约定见 [core-engine README](../core-engine/README.md#executioncontext-与-workflowcontextkeys)。

### PluginResult

插件执行结果，**业务失败应返回此结构，不要 throw**：

| 字段      | 说明                                                   |
| --------- | ------------------------------------------------------ |
| `success` | `true` 成功，`false` 失败                              |
| `message` | 可选，人类可读说明                                     |
| `data`    | 可选，成功时的业务数据（写入步骤 `result`）            |
| `code`    | 可选，失败错误码；通常由引擎填充，插件作者一般无需设置 |

```ts
// 成功
return { success: true, data: { artifact: 'path/to/out' }, message: '完成' };

// 业务失败
return { success: false, message: '参数 type 无效' };
```

### PluginFailureCodes

引擎在插件边界自动填充的失败码（插件作者通常只读、不写）：

| 常量                     | 含义                                                                      |
| ------------------------ | ------------------------------------------------------------------------- |
| `PLUGIN_NOT_FOUND`       | 插件未注册                                                                |
| `PLUGIN_EXECUTION_ERROR` | `execute` 抛出未捕获异常（经 `createPlugin` hooks 包装后也会转为 Result） |

## createPlugin

`createPlugin(options)` 返回 `PluginDefinition`，供 `createEngine({ plugins: [...] })` 注册。

```ts
import {
  createPlugin,
  getConfig,
  getLogger,
  type PluginConfig,
  type PluginContext,
  type PluginResult,
} from '@monai-devops/plugin-sdk';

async function execute(config: PluginConfig, context: PluginContext): Promise<PluginResult> {
  const type = getConfig<string>(config, 'type');
  const log = getLogger(context);

  log.info('开始执行', { type });

  if (!type) {
    return { success: false, message: '缺少 config.type' };
  }

  return { success: true, message: `${type} 执行成功` };
}

export const myPlugin = createPlugin({
  name: 'my-plugin',
  version: '1.0.0',
  description: '示例插件',
  execute,
});
```

传入 `hooks` 时，对外暴露的 `execute` 会自动编排生命周期（见下一节）；无 hooks 时 `execute` 原样导出。

## 生命周期钩子（PluginHooks）

由 `createPlugin` 绑定到 `execute` 外层，调用顺序与错误语义如下：

```
beforeExecute → execute → afterExecute
                ↓ throw
              onError → return { success: false, message }
```

| 钩子            | 触发时机                                                     |
| --------------- | ------------------------------------------------------------ |
| `beforeExecute` | `execute` 之前                                               |
| `afterExecute`  | `execute` 正常返回后（**含** `{ success: false }` 业务失败） |
| `onError`       | `beforeExecute` 或 `execute` **抛异常**时                    |

**注意**

- 业务失败（`return { success: false }`）**不**触发 `onError`，仍会调用 `afterExecute`
- 有 hooks 时，异常会被捕获并转为 `{ success: false, message }`，不会穿透到 executor
- 无 hooks 时，`execute` 内未捕获异常由 core-engine 的 `executePlugin` 捕获并填充 `PLUGIN_EXECUTION_ERROR`

## 辅助函数

### getConfig / getContext

类型安全的字典读取，避免硬编码索引：

```ts
const branch = getConfig<string>(config, 'branch');
const custom = getContext<string>(context, 'someKey'); // 仅在有约定扩展字段时使用
```

## 步骤日志（PluginLogger）

引擎在 `step:start` 之后向 context 注入 `PluginLogger`（键名 `PluginContextKeys.logger`，值为 `'logger'`）。插件通过 `getLogger(context)` 获取；无注入时回退为 `noopLogger`（静默）。

```ts
import { getLogger } from '@monai-devops/plugin-sdk';

const log = getLogger(context);

log.debug('调试信息', { detail: 1 });
log.info('阶段完成');
log.warn('资源紧张');
log.error('非致命告警');
log.append('[build] compiling...\n', 'stdout'); // stream: 'stdout' | 'stderr'
```

日志经 core-engine 串行 emit 为 `WorkflowObserver` 的 `plugin:log` 事件；全部 flush 完成后才发出 `step:finished`。调用方（如 `apps/server` WebSocket）可实时推送给前端。

| 类型              | 说明                                            |
| ----------------- | ----------------------------------------------- |
| `PluginLogLevel`  | `'debug' \| 'info' \| 'warn' \| 'error'`        |
| `PluginLogStream` | `'stdout' \| 'stderr'`（`append` 使用）         |
| `PluginLogEntry`  | `{ level, message, timestamp, data?, stream? }` |
| `noopLogger`      | 空实现，用于单测或无 observer 场景              |

## 编写约定

1. **业务失败用 Result，不用 throw** — 便于 executor 统一归类为插件失败
2. **配置与上下文用 `getConfig` / `getContext`** — 保持类型明确、键名集中
3. **日志用 `getLogger`** — 不要 `console.log`，以便调用层聚合与展示
4. **插件包只 production 依赖 SDK** — 不依赖 core-engine，保持可独立发布与测试
5. **`name` 与工作流 `step.plugin` 一致** — 注册名即调用名

## 在 monorepo 中新建插件

参考 [`plugins/test-plugin`](../../plugins/test-plugin)：

```
plugins/my-plugin/
├── package.json      # dependencies: @monai-devops/plugin-sdk
├── tsconfig.json
└── src/index.ts      # export const myPlugin = createPlugin({...})
```

`package.json` 示例：

```json
{
  "name": "my-plugin",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "dependencies": {
    "@monai-devops/plugin-sdk": "workspace:*"
  }
}
```

在服务端或脚本中注册：

```ts
import { createEngine } from '@monai-devops/core-engine';
import { myPlugin } from 'my-plugin';

const engine = createEngine({ plugins: [myPlugin] });
```

## 包导出

入口 [`index.ts`](./index.ts) 导出：

| 模块       | 导出                                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------- |
| `./types`  | `PluginManifest`、`PluginConfig`、`PluginContext`、`PluginResult`、`PluginFailureCodes`、`PluginFailureCode`          |
| `./base`   | `createPlugin`、`getConfig`、`getContext`、`PluginDefinition`、`PluginExecuteFn`、`CreatePluginOptions`               |
| `./hooks`  | `PluginHooks`                                                                                                         |
| `./logger` | `PluginLogger`、`PluginLogEntry`、`PluginLogLevel`、`PluginLogStream`、`PluginContextKeys`、`getLogger`、`noopLogger` |

## 开发与构建

```bash
# 类型检查
pnpm --filter @monai-devops/plugin-sdk check-types

# 构建（输出 dist/）
pnpm --filter @monai-devops/plugin-sdk build

# 格式 / lint
pnpm --filter @monai-devops/plugin-sdk lint
pnpm --filter @monai-devops/plugin-sdk format
```

本包无独立测试目录；契约行为由 `core-engine` 集成测试与 `plugins/test-plugin` 验证。

## 相关文档

- [core-engine README](../core-engine/README.md) — DAG 执行、资源调度、`WorkflowObserver` / `plugin:log` 语义
- [根目录 README](../../README.md) — monorepo 快速开始与整体架构
