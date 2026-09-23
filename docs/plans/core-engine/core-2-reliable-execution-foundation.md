# Core-2：可靠调度与恢复基础（进行中）

> **阶段状态：进行中（Foundation implemented）**

## 已落地基础

- Attempt 状态机：queued、leased、running、waiting、succeeded、failed、cancelled、timed_out；
- 显式 retry policy 与 idempotency key 契约；
- Attempt lease、heartbeat 和 Job checkpoint 数据结构；
- PostgreSQL `execution_jobs` 与 `execution_attempts` 持久化模型；
- 原子 lease 获取、带 token heartbeat、条件状态转换、checkpoint 保存和可恢复 Attempt 查询仓储。

## 权威边界

- PostgreSQL 是 Job、Attempt、lease 和 checkpoint 的权威状态；
- 内存 RunHandle 仍负责当前进程内即时控制，但不能作为恢复依据；
- lease 绑定 Attempt，checkpoint 绑定 Job 并记录来源 Attempt；
- 任何重试必须使用同一 jobId、新 attemptId 和显式 idempotency key。

## 下一闭环

1. 将 step:start/finished 与 Job/Attempt 仓储接通；
2. 增加 lease owner 执行服务及定期 heartbeat；
3. 启动时回收过期 lease，并从 waiting/checkpoint 恢复；
4. 将 pause/resume/cancel 写入权威状态；
5. 完成重复投递、失联和重启故障测试。
