# Core-1b：事件版本、Offset 与回放契约（已完成）

> **文档状态：已完成（Completed）**

## 1. 事件元数据

core-engine 派发的每个新生命周期事件包含：

- `eventVersion: 1`：payload schema 版本；
- `occurredAt`：UTC ISO-8601 发生时间；
- `sequence`：顶层 Run 内从 1 开始的源事件顺序。

字段保持可选，以兼容历史事件和调用方手工构造的事件。

## 2. 持久化 Offset

服务端读取或追加 `RunEvent` 后，以数据库 `eventIndex` 作为 `offset` 暴露给 API 和 WebSocket 消费者。两者语义如下：

| 字段       | 含义                                                     |
| ---------- | -------------------------------------------------------- |
| `sequence` | core-engine 产生源事件的顺序；日志合并或裁剪后可能不连续 |
| `offset`   | PostgreSQL 中持久化事件行的顺序；用于断线续传和回放      |

连续 stdout/stderr 日志可能合并到同一个 offset。合并 payload 使用 `sequence`/`sequenceEnd` 表示覆盖的源事件范围。实时订阅仍可收到各条日志，但断线后按 offset 回放时会得到合并后的 payload。

## 3. 回放规则

- WebSocket `subscribe.fromEventIndex` 暂时保留旧字段名，值按持久化 offset 解释；
- 回放包含 `offset >= fromEventIndex` 的事件；
- 事件裁剪后不得使用数组下标代替 offset；
- 历史内存事件没有 offset 时，兼容回退到数组位置；
- REST `GET /runs/:runId/events` 返回的事件包含 offset。

## 4. 验收结果

- 新事件包含版本、发生时间和 sequence；
- 数据库读取结果携带真实 eventIndex offset；
- WebSocket 可从稀疏 offset 正确回放；
- 历史无 offset 事件仍可回放；
- 流日志合并保留源 sequence 范围；
- core-engine 131 项测试及 server 非数据库单测 60 项全部通过。

## 5. 后续连接点

Core-1c 继续标准化失败原因、终态和取消原因。事件存储仍以 PostgreSQL 为权威来源；独立事件系统不在当前阶段引入。
