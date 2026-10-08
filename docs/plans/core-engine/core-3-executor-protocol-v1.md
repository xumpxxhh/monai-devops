# Core-3 Executor 协议 v1（3.0 契约候选）

> 状态：实验性 `test-plugin` 远程选路及 3.4 数据治理闭环已接入运行路径；默认关闭且生产禁用。Run 用户身份、多租户授权和生产部署边界尚未完成。

类型与预检实现位于 `packages/core-engine/executor/adapter-contract.ts`。协议与传输无关，当前只定义顶层插件步骤的单个 Attempt；DAG、Run lease、控制命令和权威投影仍由 server 持有。local adapter 是可信进程内执行，不提供隔离承诺。

## 消息与状态

`dispatch` 固定 `protocolVersion: 1`，携带 Run/Workflow/Step、确定性的 Job/Attempt 身份、插件名称和版本、幂等键、策略版本、所需能力、可选追踪 ID 与截止时间，以及 JSON 输入和 `secret://` 引用。`claim` 由服务端绑定 worker、Attempt、lease token、到期时间与持久化的 `nextSequence`；它不是插件输入。worker 按同一 token 发送从 `nextSequence` 开始严格递增的 `heartbeat`、`event`、`complete` 或 `wait`，重领同一 Attempt 时序号不能归零。`complete` 和 `wait` 互斥，均是终结当前 Attempt 的消息；等待条件和 checkpoint 必须在服务端持久化。`cancel` 带请求 ID、Attempt 和 token，属于尽力通知，不表示外部副作用已回滚。

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

不支持的版本必须拒绝，不能静默降级。所有数据必须是有限、无环的 JSON 值。输入与等待 checkpoint 各限 1 MiB；完成结果原始协议上限 1 MiB，但实验性 HTTP 传输只允许 64 KiB 内联，更大结果须先上传对象并以引用完成。事件 payload 限 64 KiB，日志超过 4096 字符须以对象引用事件回报。单对象上限 1 MiB。事件版本是正整数；事件序号不可跳跃或倒退。

## 权威性、幂等与错误

纯函数 `validateExecutorDispatch`、`assessExecutorMessage`、`assessExecutorCancel` 只是边界预检。真正接收消息时，server 必须在**同一个数据库事务/CAS**中再次校验 Attempt 身份、当前 token、租约和 deadline、递增序号、非终结状态，并写入事件或终结/等待状态；否则并发 worker 仍可穿透进程内检查。server 先在活跃 Run lease 下把批准的 dispatch 不可变地绑定到 queued Attempt；消息接收必须与该副本一致，不能由 worker 改写 deadline 或 capability。当前持久层已完成启动/续租 fencing，以及心跳、事件、`complete`、`wait` 的独立 inbox CAS。`complete` 将结果和 Attempt/Job 状态一并结算；`wait` 将 checkpoint、条件和 Attempt/Job waiting 一并保存。worker 消息先写入 `execution_attempt_messages`，不能直接代写 RunEvent。server 恢复取得 Run lease 后，已结算但未投影的完成结果可幂等补写 `step:finished` 与计数，再由 DAG 快照消费。DAG 等待钩子可确认同一持久化 worker wait 而不二次注册；整个 Run 的 waiting 状态仍须由编排器确认挂起后更新。持久层现可按 Attempt 身份读取与 Job、最新 inbox 收据一致的 `complete`/`wait` 结果；运行中等待器可轮询它并随 DAG 取消退出。注入式 adapter 测试已验证完成结果返回 DAG；实验性远程选路已装配，生产环境仍不可开放。重复序号返回 `duplicate`，旧 token 返回 `stale_lease`，过期租约返回 `expired_lease`，跳号返回 `out_of_order`，终结后新消息返回 `already_terminal`。其它拒绝码包括 `unsupported_version`、`invalid_identity`、`deadline_exceeded`、`invalid_payload`、`payload_too_large`、`wait_not_allowed`。重复终结消息不得二次结算；未来传输层应据已存结果提供幂等响应。取消是 stop hint，允许对已到期但尚未终结的 token 下发；不能以取消成功代替终结 CAS。

平台侧 fencing 只能防止旧 Attempt 改写平台状态；插件对外部系统的副作用仍须以稳定的 `idempotencyKey` 自行去重。Run lease 与 Attempt lease 独立：server 接管 Run 不得复用已终结的 Attempt，worker 重领必须取得新 token。

活跃 Run 等待 worker 时，server 仅可携当前 Run lease token 使用数据库时钟 CAS 结算过期 Attempt/Job；续租或终态消息若先提交，超时 CAS 不得再写。赢得超时后等待器向 DAG 报错，由现有步骤重试策略决定是否创建下一 Attempt。失去 Run lease 的 server 不能代替恢复器结算 worker。

服务端现有 opt-in HTTP 传输入口：`POST /{GLOBAL_API_PREFIX}/executor-workers/claim` 接收 `{ "workerId": "...", "waitMs": 0..20000, "plugins": [{ "name": "...", "version": "...", "capabilities": [] }] }`，返回 `{ "assignment": { "dispatch": ..., "claim": ... } | null }`；`POST /{GLOBAL_API_PREFIX}/executor-workers/messages` 接收单条 worker 消息并返回 CAS 决策。两者均要求 `Authorization: Bearer <EXECUTOR_WORKER_HTTP_TOKEN>`；未配置至少 32 字符凭证时返回 503。claim 只选择持有有效 Run lease、已绑定 dispatch，且插件版本与全部所需 capability 均被 worker 提供的 queued Attempt，并在同一事务启动 Attempt/Job；竞争领取只会成功一次。消息接口只从数据库装载 dispatch，不接受 worker 自带的 dispatch。生产入口必须经 TLS，凭证轮换与取消通知仍需完成；未开启远程选路时没有生产任务可领取。

独立 worker 进程已提供 `pnpm --filter server worker:dev`（或构建后 `worker:start`）。它只通过上述 HTTP 接口访问 server，不连接 PostgreSQL；启动时必须配置 worker token、`EXECUTOR_SERVER_URL` 和 `EXECUTOR_WORKER_ALLOWED_PLUGINS`。当前仅加载 `test-plugin`/`print-plugin`；实验路由只允许 `test-plugin`，其 `execution.wait` 与 `secret.read` 须经三方授权。worker 按序发送 heartbeat、受限 `plugin:log` 事件、`complete` 或 `wait`；传输失败以原序号重试，租约被拒绝时终止。server 在 Run lease 下把 worker 日志幂等投影到 Run，硬取消按配置立即或在宽限期后对 Attempt/Job 做持久化 fencing；worker 通过下一次心跳或回传发现取消，不提供即时控制推送，也不声称容器沙箱。非本机 HTTP 地址被 worker 拒绝，跨主机必须用 HTTPS。旧 worker 未上报插件能力时 claim 会收到 400，需升级 worker；共享 bearer 仅为实验兼容，Secret 与对象接口要求命名 Worker 凭据。

非生产环境可显式设置 `EXECUTOR_REMOTE_TEST_ENABLED=true`，并提供至少 32 字符的 `EXECUTOR_WORKER_HTTP_TOKEN`。这只将顶层 `test-plugin` 派发给独立 worker；派发输入仅保留 `config.type` 和允许的 checkpoint/wake payload，完成结果从持久化收据交回 DAG。capability 默认拒绝，须在插件 manifest 声明、步骤请求及 `EXECUTOR_ALLOWED_CAPABILITIES` 中同时允许；`mayWait: true` 隐含请求 `execution.wait`，还须设置 `retryPolicy.maxAttempts >= 2`。远程等待被 signal 唤醒后创建下一 Attempt，而不是复用已 waiting 的旧 Attempt。其余插件保持本地执行，生产环境强制走本地路径。

test DB 集成测试覆盖真实 HTTP 领取/完成、独立 worker 进程、worker 崩溃后的超时与旧 token 拒绝、新 manager 接管后的完成补投影、响应丢失与持续断线后的同序号重试、插件失败与日志、远程 wait/signal/新 Attempt、硬取消与迟到消息拒绝。独立 HTTP server 子进程重启和 Run owner/HTTP 同进程重启的故障注入均已通过；暂时不可恢复的 Run 改为按扫描间隔重试，不再固定延后 30 秒。协议 JSON 预检接受来自不同 JavaScript 运行域的普通对象，仍拒绝自定义原型、循环和非有限值。

## 信任边界与后续门槛

3.4 的远程试验路径由 server 写入绝对 `deadlineAt`（默认 5 分钟，可配置）。worker 到点 abort 插件，持久化 inbox 的 CAS 拒绝超过 deadline 的消息；若 worker 未及时停止，由现有 lease 超时机制最终结算。hard cancel 默认立即 fence；显式配置 `EXECUTOR_CANCEL_GRACE_MS` 后，server 持久化截止时间，Worker 心跳/日志收到 `cancel_requested` 协作退出，截止后扫描器以数据库时钟 fence Attempt/Job。宽限期内已完成的 Attempt 可以正常结算，外部副作用无法回滚。

实验性 HTTP 传输的事件子集收紧为版本 1 的 `plugin:log`，payload 只含 `level/message/timestamp`、可选 `stream` 和已授权的 `objectRef`；内联单条最多 4096 字符、每个 Attempt 最多 100 条。长日志先上传对象，事件只保留短占位与引用。worker 和服务端均执行限制，服务端在数据库事务内按 Attempt 已存事件计数拒绝超额日志。通用事件扩展需另行定义容量及敏感数据策略。

结果/日志对象记录在 PostgreSQL，引用包含版本、对象 ID、类型、字节数、SHA-256 与到期时间；上传须匹配当前 Attempt 的 Worker 身份和 lease token，完成/事件须引用同一 Attempt 的对象，读取须匹配命名 Worker 凭据。对象保留 7 天，启动时及每小时清理；旧小结果及短日志保持内联。公开 Run API 不提供对象下载，因为当前没有用户级授权。

实验性 Secret 来源是 Worker 环境：插件步骤 `secretRefs` 只允许 `secret://env/NAME`，隐含 `secret.read`；server 派发前校验插件声明、环境允许列表和命名 Worker 资格。Worker 仅解析 `EXECUTOR_WORKER_SECRET_NAMES` 白名单内的环境变量，值不经 server；直接出现在日志的值被替换，直接出现在结果的值导致通用失败。不能据此声称抵御同进程恶意插件对环境、凭据或编码后数据的主动窃取。

3.3 实验路径可用 `EXECUTOR_WORKER_IDENTITIES_JSON` 替代共享 bearer：JSON 数组中的每个身份包含 `workerId`、一至两个至少 32 字符的 `tokens` 和允许的插件名称/版本/capability 报价。认证 token 绑定 `workerId`；claim 报价只能是服务端允许集的子集；消息回传必须匹配 Attempt 当前 lease owner。轮换时先配置新旧两个 token，切换 worker 后删除旧 token。共享 `EXECUTOR_WORKER_HTTP_TOKEN` 仅为现有实验链路兼容；如配置命名身份，它不再生效。此配置不等于 Run 用户身份授权、Secret 授权或生产凭据管理。

`secretRefs` 的前缀检查不能证明任意工作流 `config/context` 没有用户自行写入的明文密钥；实验选路只把白名单裁剪后的 `config.type` 传给 Worker。不要将租约 token、Secret 值或敏感结果写入事件和普通日志。当前独立 worker 仅提供进程隔离；生产传输加密、用户授权和密钥治理未完成。

3.1 已把默认引擎的现有插件管理器包入可信进程内 adapter，保留 live logger/AbortSignal 与旧错误转换。3.2–3.4 的非生产试验选路只允许白名单裁剪后的 `test-plugin` 输入；生产信任边界和灰度退出验证仍待完成。
