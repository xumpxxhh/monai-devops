# Core-1c：失败、终态与取消原因（已完成）

> **文档状态：已完成（Completed）**

## 1. 兼容策略

现有 `status`、`success`、`failureKind` 和 `skipReason` 保持不变。新执行结果增加可选 `reason`，用于跨 core-engine、server、事件和后续 Executor 传递稳定原因。

```ts
interface ExecutionReason {
  code: string;
  category: ExecutionReasonCategory;
  retryable: boolean;
  message?: string;
}
```

`retryable` 在 Core-1 固定为 `false`。Core-2 已将 infrastructure/internal 原因标记为可重试，但只有步骤显式配置 `retryPolicy.maxAttempts > 1` 时才会创建新 Attempt。

## 2. 原因分类

稳定分类包括 business、infrastructure、configuration、internal、dependency、condition、policy、cancelled 和 interrupted。具体 `code` 优先保留插件错误码，否则复用现有 `failureKind` 或 `skipReason`。

## 3. Run 终态原因

- failed → `step_failed`；
- 用户取消 → `user_cancelled`；
- 引擎销毁 → `engine_destroyed`；
- success 不携带 terminalReason。

取消事件同时携带可选原因；旧消费者可继续只读取 mode。

## 4. Core-1 退出结论

Core-1 已完成执行身份、父子关系、事件版本、sequence/offset 回放以及结果原因标准化。所有新增字段均为加法式可选字段，旧 Workflow JSON 无需迁移。下一阶段进入 Core-2 可靠调度与恢复。
