# 共用执行内核语义盘点与兼容边界（Core-0，待评审）

> **文档状态：待评审（Draft）**
>
> 本文是 [共用内核增强前置提案](./shared-core-engine-prerequisites-draft.md) 的第一阶段产物。内容基于当前 `core-engine` 与 `apps/server` 源码盘点，先固化事实、边界和待决策项；本文本身不改变运行时行为，也不代表目标状态已经确定。

- 归档日期：2026-09-18
- 当前阶段：Core-0 语义盘点与兼容边界
- 当前状态：待评审
- 下游阶段：Core-1 执行对象与事件模型

---

## 1. 当前执行层次

当前实现存在四个相关但尚未完全统一的层次：

```text
WorkflowDefinition
    └── workflowRunId / RunHandle
          └── WorkflowStep
                └── ExecutionResult
                      └── PluginResult / 内置步骤结果
```

服务端另外持久化一个 API Run：

```text
apps/server Run
    ├── workflowSnapshot
    ├── status / counts / result
    └── RunEvent[eventIndex, payload]
```

当前事实：

- `core-engine` 以 `workflowRunId` 标识一次执行；
- `RunHandle` 管理运行控制和内存中的 in-flight 步骤；
- `ExecutionResult` 表示步骤终态；
- `WorkflowRunResult` 表示一次引擎执行的汇总结果；
- 服务端 `Run` 负责 API 可查询记录和事件持久化；
- 嵌套工作流使用派生 child run id，但当前服务端对嵌套执行采用父 Run 事件合并语义。

### 1.1 当前主要类型来源

| 语义 | 当前类型/位置 | 当前状态 |
| ---- | ------------- | -------- |
| 工作流定义 | `WorkflowDefinition` | core-engine |
| 步骤类型 | `WorkflowStep` / `StepKinds` | core-engine |
| 步骤终态 | `StepStatus` | `completed` / `skipped` / `failed` |
| 步骤失败分类 | `StepFailureKind` | plugin/resource/internal/config_resolution/subworkflow_failed |
| 工作流执行结果 | `WorkflowRunResult` | success/failed/cancelled |
| Run 控制状态 | `RunControlStatus` | running/pausing/paused/cancelling/cancelled/finished/failed/unknown |
| 服务端 Run 状态 | `RunStatus` | queued/running/paused/pausing/finished/failed/rejected/cancelled |
| 生命周期事件 | `WorkflowLifecycleEvent` | workflow、step、plugin log、iteration |
| 持久化事件 | Prisma `RunEvent` | `eventIndex + payload` |

---

## 2. 当前状态语义盘点

### 2.1 步骤状态

当前步骤只有三个终态：

| 状态 | 含义 | 是否执行过插件/内置逻辑 |
| ---- | ---- | ------------------------- |
| `completed` | 步骤执行完成；业务结果可成功或失败需结合 `success` | 是 |
| `failed` | 发生未被转换为业务结果的步骤执行错误 | 通常是 |
| `skipped` | 条件、依赖、取消、暂停或 fail-fast 导致未执行 | 否或未完成 |

注意：`completed` 与 `success` 不是同一维度。当前 `ExecutionResult` 可以表现为 `status: completed, success: false`，因此后续不能只用步骤状态判断业务成功。

### 2.2 工作流结果状态

`WorkflowRunResult.status` 当前只有：

- `success`：工作流完成且整体成功；
- `failed`：至少存在失败或执行错误；
- `cancelled`：被用户或控制逻辑取消。

服务端 API Run 另外使用 `finished` 表示正常终态。这是当前需要保留兼容、但后续需要明确映射的两套命名。

### 2.3 Run 控制状态

`RunHandle` 中的状态用于控制过程，不等价于最终业务结果：

```text
running → pausing → paused → running
running → cancelling → cancelled
running → finished / failed
```

其中：

- `pausing`、`cancelling` 是过渡状态；
- `paused` 是可恢复状态，不是最终结果；
- `finished`、`failed`、`cancelled` 是控制层终态；
- `RunControlStatus` 的 `unknown` 是查询/注册边界状态，不应作为正常执行终态。

### 2.4 服务端状态

服务端 `RunStatus` 当前兼容 API 和持久化需求：

- `queued`：已创建但尚未开始执行；
- `running`：执行中；
- `pausing` / `paused`：暂停过渡或已暂停；
- `finished`：正常完成；
- `failed`：失败完成；
- `cancelled`：取消完成；
- `rejected`：请求被接受前拒绝或无法启动。

当前 `queued` 与 `rejected` 主要存在于服务侧，core-engine 的 `WorkflowRunResult` 没有对应状态。

---

## 3. 当前失败、跳过与取消语义

### 3.1 失败分类

当前步骤失败分类如下：

| 分类 | 当前含义 | 后续共用内核关注点 |
| ---- | -------- | ------------------ |
| `plugin` | 插件未找到、插件执行异常或插件失败结果 | 业务失败与基础设施异常需进一步拆分 |
| `resource` | 资源申请或等待失败 | 是否可重试、资源是否已释放 |
| `internal` | 引擎内部错误 | 通常可重试但必须有幂等边界 |
| `config_resolution` | `$ref` 或运行时配置解析失败 | 通常不可重试，应在启动前尽量发现 |
| `subworkflow_failed` | 子工作流失败 | 需要保留父子因果关系和恢复位置 |

当前 `PluginResult.success: false` 是业务失败的主要表达方式；并非所有业务失败都会通过 `throw` 传播。

### 3.2 跳过原因

当前 `SkipReason` 包括：

- `condition_not_met`：条件不满足；
- `dependency_failed`：上游失败传播；
- `workflow_aborted`：fail-fast 或工作流中止；
- `user_cancelled`：用户取消；
- `pause_interrupted`：暂停并中断 in-flight 执行。

后续应保持“未执行”与“执行后失败”分离，不能把所有非成功结果折叠成 `failed`。

### 3.3 取消与超时

当前支持：

- `best-effort`：请求取消并等待执行自然结束；
- `hard`：通过 `AbortSignal` 尝试中止 in-flight 插件；
- hard cancel 超时后已有延迟释放资源的保护逻辑；
- fail-fast 会停止新步骤调度，并取消排队等待。

待统一的问题：

- `timeout` 是步骤失败、取消还是基础设施失败；
- AbortSignal 已发出但插件未退出时，执行权和资源如何表示；
- 用户取消与系统熔断是否需要不同原因码；
- 子执行取消如何向父执行和 API Run 映射。

---

## 4. 当前事件语义

当前事件类型：

| 事件 | 当前用途 |
| ---- | -------- |
| `workflow:start` | 工作流执行开始 |
| `workflow:finished` | 工作流产生最终结果 |
| `workflow:cancelled` | 工作流取消完成/通知 |
| `workflow:paused` | 工作流进入暂停状态 |
| `workflow:resumed` | 工作流恢复 |
| `workflow:iteration:start` | 嵌套工作流一轮开始 |
| `workflow:iteration:finished` | 嵌套工作流一轮结束 |
| `step:queued` | 步骤进入资源调度流程，不保证已经物理等待 |
| `step:start` | 步骤开始执行 |
| `step:finished` | 步骤产生终态结果 |
| `plugin:log` | 插件日志或流式输出 |

当前事件具备：

- `workflowRunId`；
- `WorkflowRunMeta`；
- 嵌套执行可选的 `parent`；
- 插件日志和步骤结果；
- 服务端按 `eventIndex` 持久化。

当前事件尚未统一具备：

- 独立 `jobId` / `attemptId`；
- 全局 sequence 或跨 Run 因果关系；
- payload schema version；
- 明确的 event offset / replay cursor；
- Executor 身份、租约和恢复信息。

因此 Core-1 不应直接替换现有事件类型，而应在保留旧事件兼容的前提下增加统一执行元数据。

---

## 5. 兼容边界建议

以下内容建议作为后续实现的兼容约束：

1. 历史工作流中没有 `kind` 的步骤继续按 `plugin` 处理；
2. 现有 `WorkflowRunResult` 和 API `RunStatus` 暂不删除；
3. 旧事件 type 保持可反序列化和前端可展示；
4. 新增事件字段采用加法式、可选字段，并保留 payload 版本；
5. 现有 `workflowRunId` 继续作为顶层外部查询标识；
6. 现有子工作流事件的 `parent` 语义保持兼容；
7. 业务失败仍可通过 `PluginResult.success: false` 表达；
8. 新增 Attempt/Execution 标识不能改变旧 API 的 Run 聚合语义；
9. 旧工作流不要求迁移即可继续执行；
10. 任何改变重试、取消或资源释放语义的改动必须有迁移说明和回归测试。

---

## 6. Core-0 输出与 Core-1 输入

### Core-0 已确认的事实

- 当前存在控制状态、业务结果状态和服务持久化状态三套相关语义；
- 步骤 `status` 与 `success` 必须保持分离；
- 业务失败、基础设施失败、取消和跳过不能在下一阶段被简单合并；
- 事件模型已经能支撑实时展示，但不足以单独支撑可靠恢复和跨 Executor 执行；
- 兼容策略应以加法式扩展为主，避免一次性替换旧 API。

### Core-1 待解决问题

1. 是否引入统一的 `ExecutionStatus` 和状态转换表；
2. `Run`、`Job`、`Attempt`、`Execution` 是否需要正式拆分；
3. 哪些状态必须落库，哪些状态由事件重建；
4. 事件 sequence、offset、版本和回放接口如何定义；
5. 重试、checkpoint、lease 和幂等键如何进入执行契约；
6. 本地 Executor 与远程 Executor 是否使用同一协议。

---

## 7. 当前阶段结论

本阶段暂不修改 `packages/core-engine` 和 `apps/server` 的运行时代码。下一步进入 Core-1 前，应先评审本清单中“兼容边界建议”和“待解决问题”，然后再选择一个最小垂直切片实现，优先验证：

```text
一个 Job/Attempt 标识
    + 一条带 sequence 的事件
    + 一次可验证的失败/重试语义
```

如果该切片无法在不破坏现有 Run API 的情况下落地，应先调整设计，不直接扩大重构范围。
