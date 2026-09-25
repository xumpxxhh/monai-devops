# Core-3 Executor 协议 v1（3.0 契约候选）

> 状态：纯契约与测试已实现；尚未接入运行路径。传输、worker 身份、Secret 来源和部署边界留到远程闭环前评审。

类型与预检实现位于 `packages/core-engine/executor/adapter-contract.ts`。协议与传输无关，当前只定义顶层插件步骤的单个 Attempt；DAG、Run lease、控制命令和权威投影仍由 server 持有。local adapter 是可信进程内执行，不提供隔离承诺。

## 消息与状态

`dispatch` 固定 `protocolVersion: 1`，携带 Run/Workflow/Step、确定性的 Job/Attempt 身份、插件名称和版本、幂等键、策略版本、所需能力、可选追踪 ID 与截止时间，以及 JSON 输入和 `secret://` 引用。`claim` 由服务端绑定 worker、Attempt、lease token 和到期时间；它不是插件输入。worker 按同一 token 发送从 1 开始严格递增的 `heartbeat`、`event`、`complete` 或 `wait`。`complete` 和 `wait` 互斥，均是终结当前 Attempt 的消息；等待条件和 checkpoint 必须在服务端持久化。`cancel` 带请求 ID、Attempt 和 token，属于尽力通知，不表示外部副作用已回滚。

```json
{
  "protocolVersion": 1,
  "runId": "run-1",
  "workflowId": "workflow-1",
  "stepId": "approve",
  "execution": { "jobId": "run-1/approve", "attemptId": "run-1/approve/attempt-0", "attempt": 0 },
  "plugin": { "name": "approval", "version": "1.2.0" },
  "idempotencyKey": "run-1/approve",
  "policyVersion": "policy-1",
  "requiredCapabilities": ["execution.wait"],
  "input": { "config": { "approvalId": "a-1" }, "context": {} },
  "secretRefs": { "apiKey": "secret://project/api-key" }
}
```

```json
{
  "protocolVersion": 1,
  "execution": { "jobId": "run-1/approve", "attemptId": "run-1/approve/attempt-0", "attempt": 0 },
  "leaseToken": "opaque-token",
  "sequence": 1,
  "occurredAt": "2026-09-25T10:00:00.000Z",
  "kind": "wait",
  "checkpoint": { "cursor": 1 },
  "condition": { "kind": "signal", "key": "approved" }
}
```

不支持的版本必须拒绝，不能静默降级。所有数据必须是有限、无环的 JSON 值。输入、完成结果、等待 checkpoint 各限 1 MiB；事件 payload 限 64 KiB（UTF-8 序列化字节）。超过阈值的对象引用属于 3.4，v1 当前不接受大对象内联。事件版本是正整数；事件序号不可跳跃或倒退。

## 权威性、幂等与错误

纯函数 `validateExecutorDispatch`、`assessExecutorMessage`、`assessExecutorCancel` 只是边界预检。真正接收消息时，server 必须在**同一个数据库事务/CAS**中再次校验 Attempt 身份、当前 token、租约和 deadline、递增序号、非终结状态，并写入事件或终结/等待状态；否则并发 worker 仍可穿透进程内检查。重复序号返回 `duplicate`，旧 token 返回 `stale_lease`，过期租约返回 `expired_lease`，跳号返回 `out_of_order`，终结后新消息返回 `already_terminal`。其它拒绝码包括 `unsupported_version`、`invalid_identity`、`deadline_exceeded`、`invalid_payload`、`payload_too_large`、`wait_not_allowed`。重复终结消息只应返回既有结算结果，不得二次投影。取消是 stop hint，允许对已到期但尚未终结的 token 下发；不能以取消成功代替终结 CAS。

平台侧 fencing 只能防止旧 Attempt 改写平台状态；插件对外部系统的副作用仍须以稳定的 `idempotencyKey` 自行去重。Run lease 与 Attempt lease 独立：server 接管 Run 不得复用已终结的 Attempt，worker 重领必须取得新 token。

## 信任边界与后续门槛

`secretRefs` 的前缀检查不能证明 `input.config/context` 没有明文密钥；3.3/3.4 必须在派发前施加能力授权、Secret 分类与脱敏，worker 身份与引用解析也必须有独立鉴权。不要将租约 token、Secret 值或敏感结果写入事件和普通日志。当前契约没有宣称远程 worker 隔离、传输加密或数据库持久化已经完成。

3.1 可仅把现有可信本地插件执行包入 adapter，保持旧行为。进入 3.2 前还需确定传输与认证、worker 隔离级别、Secret 来源和显式选路/回滚开关，并以两进程 PostgreSQL 测试证明上述 CAS 语义。
