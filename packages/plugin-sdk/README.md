# @monai-devops/plugin-sdk

插件契约与辅助工具：定义「什么是插件」、如何校验 config、如何协作取消，以及如何向编排层输出日志。

本包**不负责**插件注册表或工作流调度；那一层由 `@monai-devops/core-engine`（及上层应用）完成。插件作者日常只依赖本 SDK。

## 核心约定

1. **`execute` 以 `PluginResult` 表达成败**，业务失败返回 `{ success: false }`，不要靠 throw 表示「这一步失败了」。
2. **取消是协作式的**：编排层往 `context` 注入 `AbortSignal`；插件在可中断点调用 `throwIfAborted` / `await sleep(...)`，抛出 `PluginCancelledError`。`createPlugin` 会把它收成 `PLUGIN_CANCELLED` 结果。
3. **其它未捕获 throw**：若走了 `hooks`，`createPlugin` 会调 `onError` 并返回 `{ success: false, message }`；若无 hooks、且不是 `PluginCancelledError`，异常会继续向外抛（引擎的 plugin manager 再兜底）。
4. **`configSchema` 做运行时校验**；**`resultSchema` 只作结构声明**（前端选字段、工作流 `$ref` 静态校验），不对 `data` 做运行时校验。

## 安装与环境

- Node.js `>= 20`
- ESM（`"type": "module"`）
- 依赖：`zod ^3.24`

```bash
pnpm --filter @monai-devops/plugin-sdk build
pnpm --filter @monai-devops/plugin-sdk test
```

工作区引用：

```ts
import { createPlugin, z, getLogger, sleep, throwIfAborted } from '@monai-devops/plugin-sdk';
```

包同时再导出 `z`、`ZodType`、`ZodError`，插件侧一般不必再单独依赖 zod（除非版本要对齐）。

---

## 快速开始

```ts
import { createPlugin, getLogger, sleep, throwIfAborted, z } from '@monai-devops/plugin-sdk';
import type { PluginContext, PluginResult } from '@monai-devops/plugin-sdk';

const configSchema = z.object({
  type: z.enum(['unit', 'integration', 'e2e']),
  label: z.string().default('default'),
});

const resultSchema = z.object({
  type: z.enum(['unit', 'integration', 'e2e']),
  message: z.string(),
});

async function execute(
  config: z.infer<typeof configSchema>,
  context: PluginContext,
): Promise<PluginResult> {
  const log = getLogger(context);

  log.info('开始执行', { type: config.type });
  await sleep(1000, context); // 可被 AbortSignal 打断
  throwIfAborted(context);

  log.append(`[runner] ${config.type} done\n`, 'stdout');

  return {
    success: true,
    message: 'ok',
    data: { type: config.type, message: `${config.label} finished` },
  };
}

export const myPlugin = createPlugin({
  name: 'my-plugin',
  version: '1.0.0',
  description: '示例插件',
  configSchema,
  resultSchema,
  execute,
});
```

无 `configSchema` 时仍可用（向后兼容）：`execute` 收到原始 `PluginConfig`（`Record<string, unknown>`）。

---

## 类型与结果

### Manifest / Definition

```ts
interface PluginManifest {
  name: string;
  version: string;
  description?: string;
}

interface PluginDefinition extends PluginManifest {
  execute: (config: PluginConfig, context: PluginContext) => Promise<PluginResult>;
  hooks?: PluginHooks;
  configSchema?: ZodType;   // 有则 execute 前 safeParse
  resultSchema?: ZodType;   // 声明 data 形状；不做运行时校验
}
```

### Config / Context

| 类型 | 含义 |
|---|---|
| `PluginConfig` | 引擎边界：来自 JSON 的原始 config |
| `InferPluginConfig<T>` | `z.infer<T>`，供带 schema 的插件内部使用 |
| `PluginContext` | 索引签名对象；编排器可注入任意扩展字段 |

### `PluginResult`

```ts
interface PluginResult {
  success: boolean;
  message?: string;
  data?: unknown;
  code?: PluginFailureCode; // 仅失败时使用
}
```

### 失败码 `PluginFailureCodes`

| 码 | 谁产生 | 含义 |
|---|---|---|
| `PLUGIN_CONFIG_INVALID` | `createPlugin`（有 `configSchema`） | Zod 校验失败 |
| `PLUGIN_CANCELLED` | `createPlugin`（捕获 `PluginCancelledError`） | 协作取消 |
| `PLUGIN_NOT_FOUND` | 引擎 plugin manager | 未注册该插件名 |
| `PLUGIN_EXECUTION_ERROR` | 引擎 plugin manager | execute 意外 throw（非取消） |

SDK 本身只直接产生前两种；后两种由上层在「查表 / 兜底 catch」时写入。

### `PluginCancelledError`

```ts
throw new PluginCancelledError();           // 默认文案：「插件执行已取消」
throw new PluginCancelledError('自定义');
```

`createPlugin` 在 `execute` / hooks 路径上捕获后返回：

```ts
{ success: false, code: 'PLUGIN_CANCELLED', message }
```

---

## `createPlugin`

工厂函数：把作者写的 `execute` 包装成对外统一的 `PluginDefinition.execute`。

### 执行流水线（有 `configSchema`）

```
rawConfig
  → configSchema.safeParse
       ├─ 失败 → { success:false, code: PLUGIN_CONFIG_INVALID, message: formatZodError(...) }
       └─ 成功 → parsed.data
            → hooks.beforeExecute?（收到已解析 config）
            → execute(parsed, context)
            → hooks.afterExecute?(result, ...)
            → 返回 result
```

校验失败时**不会**调用 `execute` 与 hooks。

### 无 `configSchema`

跳过解析，直接 `wrapWithHooks(legacyExecute)`；`execute` / hooks 看到的是原始 `PluginConfig`。

### 取消包装

无论是否配置 hooks，用户 `execute` 都会先经 `wrapWithCancellation`：`PluginCancelledError` → `PLUGIN_CANCELLED` Result；其它错误原样抛出（再由 hooks 的外层 catch 或调用方处理）。

### Hooks 错误语义

```ts
interface PluginHooks<TConfig = PluginConfig> {
  beforeExecute?: (config: TConfig, context: PluginContext) => void | Promise<void>;
  afterExecute?: (
    result: PluginResult,
    config: TConfig,
    context: PluginContext,
  ) => void | Promise<void>;
  onError?: (error: Error, config: TConfig, context: PluginContext) => void | Promise<void>;
}
```

| 情况 | `afterExecute` | `onError` | 返回值 |
|---|---|---|---|
| `execute` 返回 `{ success: false }`（业务失败） | ✅ 仍调用 | ❌ | 原 Result |
| `execute` / `beforeExecute` **抛** `PluginCancelledError` | ❌ | ❌ | `PLUGIN_CANCELLED` |
| `execute` / `beforeExecute` **抛** 其它 Error | ❌ | ✅ | `{ success: false, message }` |
| 无 hooks，抛非取消异常 | — | — | 继续向外抛 |

要点：**业务失败用 Result，不走 `onError`；异常才走 `onError`。**

### `resultSchema`

挂在 `PluginDefinition` 上供编排层 / 前端读取。`createPlugin` **不会**在运行时用它对 `data` 做 `safeParse`。

---

## 日志与 Context 键

编排层（如 core-engine）通常注入：

```ts
PluginContextKeys.logger  // 'logger'
PluginContextKeys.signal // 'signal'
```

### `PluginLogger`

```ts
interface PluginLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  /** 流式片段（如子进程 stdout/stderr） */
  append(chunk: string, stream?: 'stdout' | 'stderr'): void;
}
```

```ts
const log = getLogger(context); // 无 logger 时退回 noopLogger
log.info('step', { id: 1 });
log.append('line\n', 'stdout');
```

`PluginLogEntry` 形状（供观察者落库 / 推送）：

```ts
{
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  timestamp: number;
  data?: Record<string, unknown>;
  stream?: 'stdout' | 'stderr';
}
```

### 取消辅助

| API | 行为 |
|---|---|
| `getAbortSignal(context)` | 读取 `context.signal` |
| `isAborted(context)` | 无 signal 或未 abort → `false` |
| `throwIfAborted(context)` | 已 abort → 抛 `PluginCancelledError` |
| `sleep(ms, context)` | 可中断等待；abort 时以 `PluginCancelledError` reject；无 signal 则普通 `setTimeout` |

长任务推荐模式：

```ts
while (!done) {
  throwIfAborted(context);
  await doChunk();
  await sleep(0, context); // 或固定间隔，给 abort 机会
}
```

---

## 其它辅助

```ts
getConfig<T>(config, key): T | undefined;   // config[key]
getContext<T>(context, key): T | undefined; // context[key]

formatZodError(error: ZodError): string;
// 例："type: Invalid enum value; label: Required"
// 无 path 时用 "(root): ..."
```

`formatZodError` 用于 `PLUGIN_CONFIG_INVALID` 的 `message`，也可在插件自定义校验时复用。

---

## 导出一览

| 来源 | 导出 |
|---|---|
| `zod` | `z`、`ZodType`、`ZodError` |
| `types` | `PluginManifest`、`PluginConfig`、`InferPluginConfig`、`PluginContext`、`PluginResult`、`PluginFailureCode`、`PluginFailureCodes`、`PluginCancelledError` |
| `base` | `createPlugin`、`getConfig`、`getContext`、及相关 options / `PluginDefinition` / `PluginExecuteFn` 类型 |
| `hooks` | `PluginHooks` |
| `logger` | `PluginLogger`、`PluginLogEntry`、`PluginLogLevel`、`PluginLogStream`、`PluginContextKeys`、`noopLogger`、`getLogger`、`getAbortSignal`、`isAborted`、`throwIfAborted`、`sleep` |
| `validation` | `formatZodError` |

---

## 目录结构

```
packages/plugin-sdk/
├── index.ts           # 公共入口
├── types/             # Manifest、Result、失败码、PluginCancelledError
├── base/              # createPlugin、getConfig、getContext
├── hooks/             # PluginHooks
├── logger/            # Logger、Abort 辅助、Context 键
├── validation/        # formatZodError
└── __tests__/
```

## 开发脚本

| 脚本 | 作用 |
|---|---|
| `pnpm build` | `tsc -p tsconfig.build.json` → `dist/` |
| `pnpm check-types` | 类型检查 |
| `pnpm test` | Node test runner（`scripts/run-tests.mjs`） |
| `pnpm lint` / `lint:fix` | ESLint |
| `pnpm format` / `format:check` | Prettier |

发布物仅包含 `dist/`（`exports` 指向 `./dist/index.js` 与 `.d.ts`）。

---

## 编写插件时的检查清单

- [ ] `name` / `version` 稳定；引擎按 `name` 注册与查找
- [ ] 优先提供 `configSchema`，让非法配置在进业务逻辑前失败
- [ ] 成功时在 `data` 中返回可被下游 `$ref` 的结构化数据，并声明 `resultSchema`
- [ ] 业务失败：`return { success: false, message }`；不要 throw
- [ ] 长任务：周期调用 `throwIfAborted` / `sleep(..., context)`
- [ ] 日志：`getLogger(context)`，流式输出用 `append`
- [ ] 需要副作用编排时再用 hooks；分清「Result 失败」与「异常」两条路径
