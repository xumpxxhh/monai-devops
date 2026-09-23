# Core-2：可靠调度与恢复基础（进行中）

> **阶段状态：进行中（Runtime projection implemented）**

## 已落地基础

- Attempt 状态机：queued、leased、running、waiting、skipped、succeeded、failed、cancelled、timed_out；
- 显式 retry policy 与 idempotency key 契约；
- Attempt lease、heartbeat 和 Job checkpoint 数据结构；
- PostgreSQL `execution_jobs` 与 `execution_attempts` 持久化模型；
- 原子 lease 获取、带 token heartbeat、条件状态转换、checkpoint 保存和可恢复 Attempt 查询仓储。
- 顶层步骤事件已投影到 Job/Attempt：queued、running 和所有终态均写入权威状态；
- 本地 Executor 已具备 lease owner、周期 heartbeat 和终态清理；
- 服务启动时扫描过期 leased/running Attempt，标记为 timed_out，持久化 waiting 保持待恢复状态；
- lease 重领条件已收紧，终态 Attempt 不会因残留过期时间被重新领取。

## 权威边界

- PostgreSQL 是 Job、Attempt、lease 和 checkpoint 的权威状态；
- 内存 RunHandle 仍负责当前进程内即时控制，但不能作为恢复依据；
- lease 绑定 Attempt，checkpoint 绑定 Job 并记录来源 Attempt；
- 任何重试必须使用同一 jobId、新 attemptId 和显式 idempotency key。

## 当前边界

- 当前 RunManager 的事件持久化是异步投影；lease 已能记录和检测失联，但尚未成为插件执行前的强制授权闸门；
- 嵌套子执行暂不写 Job/Attempt 表，避免在子 Run 不独立落表时破坏外键和 `(runId, stepId)` 唯一性；
- 过期 Attempt 当前进入 timed_out，不自动创建下一 Attempt；重试策略执行器将在下一闭环实现；
- waiting/checkpoint 已有持久化契约，尚未接入实际唤醒协议。

## 下一闭环

1. 实现 retry policy 执行器，过期/可重试失败生成新 Attempt；
2. 将 lease 获取前移为实际执行授权闸门；
3. 将 pause/resume/cancel 写入跨进程控制命令并由 Executor 消费；
4. 接入 waiting/checkpoint 的持久化唤醒；
5. 完成重复投递、失联和重启故障测试。
