# Core-2：可靠调度与恢复基础（进行中）

> **阶段状态：进行中（Cross-process control implemented）**

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

## 权威边界

- PostgreSQL 是 Job、Attempt、lease 和 checkpoint 的权威状态；
- 内存 RunHandle 负责实际控制当前执行；PostgreSQL 控制命令是跨进程请求、认领和完成状态的权威记录；
- lease 绑定 Attempt，checkpoint 绑定 Job 并记录来源 Attempt；
- 任何重试必须使用同一 jobId、新 attemptId 和显式 idempotency key。

## 当前边界

- 终态仍由有序事件链投影，执行前授权已是同步强制闸门；
- 嵌套子执行暂不写 Job/Attempt 表，避免在子 Run 不独立落表时破坏外键和 `(runId, stepId)` 唯一性；
- 当前进程内的可重试失败已经自动创建下一 Attempt；服务重启后扫描出的 timed_out Attempt 尚未自动恢复；
- waiting/checkpoint 已有持久化契约，尚未接入实际唤醒协议。
- 控制命令已经跨进程持久化，但当前仍由内嵌 Executor 轮询；远程 Executor 协议留到 Core-3。

## 下一闭环

1. 接入 waiting/checkpoint 的持久化唤醒；
2. 为启动扫描出的 timed_out Attempt 执行恢复策略；
3. 完成重复投递、失联和重启故障测试。
