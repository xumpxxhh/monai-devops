# Core-1：执行身份最小切片（已评审）

> **文档状态：已评审（Accepted for current slice）**
>
> 本文是 [Core-0 语义盘点](./execution-semantics-inventory-draft.md) 的第一个实现切片提案。目标是先建立稳定的 Job/Attempt 身份，不引入数据库迁移、不改变调度顺序，也不改变旧事件的必填字段。

### 评审结论

- `ExecutionIdentity` 是内核生成、调用方按整体消费的 opaque identity；当前不承诺从字符串反解析组成部分。
- 所有经 `executeWorkflow` 管理的步骤都必须获得身份，包括条件跳过、依赖失败、取消或 fail-fast 前尚未调度的步骤。
- 直接调用内部 `executeStep` 且未传入身份时继续兼容旧行为，不由内核补造身份。
- `execution` 和 `sequence` 均保持可选，避免破坏历史 JSON、事件消费者和手工构造对象。
- `sequence` 仅保证单个顶层 Run 生命周期内唯一且递增；嵌套 Run 共用该序列空间，Run 完成后释放状态。
- `sequence` 与数据库 `eventIndex` 保持独立：前者属于源执行事件，后者只表示持久化行顺序。连续流日志压缩后保留首个 `sequence`，并以可选 `sequenceEnd` 标记覆盖范围。
- 本切片不引入持久化 Attempt、重试、checkpoint、lease 或远程 Executor 协议；这些议题进入后续 RFC。

## 1. 目标

为每次步骤执行建立两层身份：

```text
jobId     = <workflowRunId>/<stepId>
attemptId = <jobId>/attempt-<attempt>
```

当前内核每个步骤在一次 Run 中只执行一次，因此默认 `attempt = 0`。未来加入重试时，保持 `jobId` 不变，仅递增 `attempt` 并生成新的 `attemptId`。

示例：

```json
{
  "jobId": "run-42/build",
  "attemptId": "run-42/build/attempt-0",
  "attempt": 0
}
```

## 2. 类型设计

新增 `ExecutionIdentity`：

```ts
export interface ExecutionIdentity {
  jobId: string;
  attemptId: string;
  attempt: number;
}
```

在以下对象增加可选字段：

```ts
interface ExecutionContext {
  execution?: ExecutionIdentity;
}

interface ExecutionResult {
  execution?: ExecutionIdentity;
}
```

### 2.1 事件顺序（已实现的兼容性小切片）

为便于同一 Run 内的观测、调试和后续持久化映射，生命周期事件增加可选的内存序列号 `sequence`：

- 每个顶层 Run 从 `1` 开始递增；
- 嵌套工作流事件沿用顶层 Run 的序列空间；
- 事件派发器统一注入，保证异步 Observer 收到的顺序与序列一致；
- Run 结束后清理序列状态，不引入数据库字段，也不替代未来可能的 `eventIndex`/offset；
- 字段保持可选，旧事件消费者无需升级。

这只是观测层的顺序标识，不代表可靠持久化游标。服务端将其原样保存在事件 payload 中，但不映射为数据库 `eventIndex`：事件裁剪和连续流日志合并都会使两者不再一一对应。合并后的流日志保留首个 `sequence`，并使用可选 `sequenceEnd` 表示包含的源事件范围。

事件中的步骤生命周期也增加可选 `execution`：

- `step:queued`；
- `step:start`；
- `step:finished`。

字段保持可选，以兼容：

- 旧的 `ExecutionResult` JSON；
- 调用方直接调用 `executeStep` 的场景；
- 历史持久化事件；
- 未升级的前端事件消费者。

## 3. 注入位置

在 `executeWorkflow` 的 `runStep` 边界创建身份：

```ts
const execution = createExecutionIdentity(workflowRunId, step.id, 0);
```

将其注入本次 `ExecutionContext`，随后：

1. `step:queued` 读取 `context.execution`；
2. `step:start` 读取 `context.execution`；
3. `notifyStepComplete` 将身份写入 `ExecutionResult`；
4. `step:finished` 同时携带 `execution` 和带身份的结果；
5. `WorkflowRunResult.results` 自动保留步骤执行身份。

如果调用方直接调用内部步骤执行而未提供身份，则继续产生没有该字段的旧兼容结果。

## 4. 不在本切片处理的内容

- 不新增 Prisma 表或字段；
- 不新增 `eventIndex` 之外的持久化 sequence；
- 不实现重试；
- 不改变 `WorkflowRunStatus`、`RunStatus` 或 `StepStatus`；
- 不改变资源键和资源释放逻辑；
- 不引入远程 Executor/Runner 协议；
- 不把 `jobId` 当作外部 API 查询 ID。

## 5. 验收测试

应新增或补充以下测试：

1. 单步骤成功时，`step:start`、`step:finished` 和结果拥有相同的 `jobId/attemptId`；
2. 多步骤 Run 的不同步骤 `jobId` 不冲突；
3. 两次独立 Run 的同名步骤身份不冲突；
4. 嵌套工作流的父子 Run 身份不同，且现有 `parent` 字段继续保留；
5. 失败、跳过、取消和暂停中断结果同样保留执行身份；
6. 历史手工构造的无 `execution` 结果仍能序列化和反序列化；
7. 现有 Observer、服务端序列化和 Run 事件测试保持通过。

## 6. 后续连接点

该切片完成后，Core-1 的下一步才评审：

- `Attempt` 是否需要正式成为持久化对象；
- 重试时如何复用 `jobId`、递增 `attempt`；
- checkpoint 和 lease 应绑定到 Job 还是 Attempt；
- 本地 Executor 与远程 Executor 是否共享该身份协议。

在这些问题确定前，不应直接把 `attemptId` 扩展成重试或恢复机制。
