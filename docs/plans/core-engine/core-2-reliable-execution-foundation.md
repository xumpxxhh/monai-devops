# Core-2：可靠调度与恢复基础（进行中）

> **阶段状态：进行中（服务端恢复快照重建已实现，自动接管尚未接通）**

## 已落地基础

- Attempt 状态机：queued、leased、running、waiting、skipped、succeeded、failed、cancelled、timed_out；
- 显式 retry policy 与 idempotency key 契约；
- Attempt lease、heartbeat 和 Job checkpoint 数据结构；
- PostgreSQL `execution_jobs` 与 `execution_attempts` 持久化模型；
- 原子 lease 获取、带 token heartbeat、条件状态转换、checkpoint 保存和可恢复 Attempt 查询仓储。
- 顶层步骤事件已投影到 Job/Attempt：queued、running 和所有终态均写入权威状态；
- 本地 Executor 已具备 lease owner、周期 heartbeat 和终态清理；
- 顶层步骤在取得资源后、发出 `step:start` 和调用插件前必须先取得数据库 lease；授权失败会阻止插件执行；
- 服务启动时扫描过期 leased/running Attempt，标记为 timed_out，持久化 waiting 保持待恢复状态；
- lease 重领条件已收紧，终态 Attempt 不会因残留过期时间被重新领取。
- WorkflowStep 支持显式 `retryPolicy`；默认 `maxAttempts=1`，保持旧工作流不重试；
- infrastructure/internal 失败可被策略重试，business/configuration/dependency/cancelled 等失败不自动重试；
- 每次重试保持 jobId、递增 attempt 并生成新 attemptId，所有 Attempt 事件和数据库历史均保留；
- backoff 采用指数增长并受 `maxBackoffMs` 上限约束；中间失败不计入 Run 的最终步骤计数；
- server 规范化与 web 编辑器导入/保存链路会保留 retryPolicy。
- pause/resume/cancel 在调用本地执行器前先写入 PostgreSQL `execution_control_commands`；API 响应携带 commandId 与 pending/applied/rejected 状态；
- 持有 RunHandle 的 Executor 周期读取命令并原子认领，非持有进程不会误消费；认领超时后允许重新领取，避免消费者崩溃导致命令永久悬挂；
- 同进程控制仍即时执行；跨进程请求保持 pending，直到实际持有者消费；尚未启动的 queued Run 可在无内存 owner 时直接持久化取消；
- pause/resume/cancel 的状态投影仍沿用原有 Run 状态与事件语义，旧客户端可忽略新增的 control 响应字段。
- Web 控制栏区分 pending/applied/rejected，不会把仍在等待其他执行节点处理的请求误报为已经完成。
- Attempt 新增持久化等待条件：signal key 或 timer wakeAt、可选 timeoutAt、wakeReadyAt 与唤醒载荷；
- `registerWait` 以有效 lease token、Attempt 身份和递增 checkpoint version 为闸门，在同一数据库事务中保存 Job checkpoint、切换 Attempt/Job 为 waiting，并清除 lease；
- `signalWait` 只接受匹配 key 的未超时 waiting Attempt，同一信号重复投递仅首个生效；timer 和超时由周期扫描标记，超时 Attempt/Job 进入 timed_out；
- waiting Attempt 只有在被标记为 ready 后才能重新获取 lease，避免启动扫描或误投递直接越过等待条件。
- `executeWorkflow` 可接收恢复快照：从已成功完成的步骤结果重建 DAG 入度与下游输入，恢复完整 state，并以指定的下一 Attempt 序号续跑未完成步骤；快照会校验步骤、依赖、state 和 retry 上限，已完成步骤不重发完成事件。
- 服务端可从持久化 Run 事件及 Job/Attempt 视图构建恢复快照：按 Run 计数校验已完成事件未被裁剪，核对 Job/Attempt 终态与依赖，并只为排队中或允许重试且尚有额度的步骤指定 Attempt；嵌套事件不参与顶层恢复。此入口只读取和校验，不执行 Run。

## 权威边界

- PostgreSQL 是 Job、Attempt、lease 和 checkpoint 的权威状态；
- 内存 RunHandle 负责实际控制当前执行；PostgreSQL 控制命令是跨进程请求、认领和完成状态的权威记录；
- lease 绑定 Attempt，checkpoint 绑定 Job 并记录来源 Attempt；
- 任何重试必须使用同一 jobId、新 attemptId 和显式 idempotency key。

## 当前边界

- 终态仍由有序事件链投影，执行前授权已是同步强制闸门；
- 嵌套子执行暂不写 Job/Attempt 表，避免在子 Run 不独立落表时破坏外键和 `(runId, stepId)` 唯一性；
- 当前进程内的可重试失败已经自动创建下一 Attempt；服务重启后扫描出的 timed_out Attempt 尚未自动恢复；
- 服务端恢复快照重建已接入 Run/Job 仓储，但尚无 Run 所有权 lease，因此不能安全地自动接管旧 Run；checkpoint 的插件级续跑、waiting/ready、paused、已有失败/跳过分支仍明确拒绝。Run 事件可能裁剪，缺失已完成步骤时拒绝重建。含 stateSchema 且没有已完成 `set_state` 输出的 Run 也拒绝重建，直到初始 state 有不暴露于公开 metadata 的私有持久化位置。失联步骤的幂等性仍须由接管方裁决。
- 等待与唤醒已有数据库原子协议，但尚未由工作流步骤调用；ready Attempt 不会自动重建 RunHandle 或续跑 DAG。下一批须接入运行时恢复，才能形成用户可见的长任务等待闭环。
- 控制命令已经跨进程持久化，但当前仍由内嵌 Executor 轮询；远程 Executor 协议留到 Core-3。

## 下一闭环

1. 为 Run 增加所有权 lease 与私有 state 持久化，再将已校验快照接入受保护的自动接管；
2. 为启动扫描出的 timed_out Attempt 执行恢复策略；
3. 完成重复投递、失联和重启故障测试。
