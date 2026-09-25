# Core-2：可靠调度与恢复基础（进行中）

> **阶段状态：进行中（顶层插件的持久化等待/唤醒已形成 signal 与 timer 闭环）**

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
- 服务端可从持久化 Run 事件及 Job/Attempt 视图构建恢复快照：按 Run 计数校验已完成事件未被裁剪，核对 Job/Attempt 终态与依赖，并只为排队中或允许重试且尚有额度的步骤指定 Attempt；嵌套事件不参与顶层恢复。快照构造器本身只读取和校验。
- Run 新增 token 约束的独占 lease：提交后必须先原子认领才能启动执行，周期续租，完成后释放；失去 lease 会停止持久化本地事件，并阻止后续步骤越过执行前授权闸门。过期 lease 可被其他 owner 认领，旧 token 不能续租或释放新 lease。
- 初始 state 写入 Run 的私有 `recovery_state` 字段，不进入 `RunRecord`、列表或详情 API；恢复快照在没有已完成 `set_state` 输出时可读取该字段。旧 Run 未保存此字段的场景仍拒绝恢复。
- 服务启动和周期扫描先以数据库原子条件将过期 Attempt/Job 一起标为 timed_out（Attempt 续租先发生、或 Run lease 仍有效时不误判），再查找 lease 过期的 running Run 与足够早的未认领 queued Run；恢复管理器先认领 Run、再校验快照、最后异步续跑，失败则释放 lease 并保留 Run 原状态。
- 失联步骤仅在显式 retry policy 尚有 Attempt 额度、Job 有持久化 idempotency key、失败原因为可重试或 lease 超时的情况下续跑；成功步骤不再执行，下一 Attempt 使用递增身份。Run 事件投影及步骤执行前均重新确认 Run lease。两实例并发认领只有一个可启动，数据库集成测试覆盖已完成步骤跳过、Attempt 递增和最终状态。
- 条件不满足而跳过的步骤可从持久化 `step:finished` 与 SKIPPED Attempt/Job 重建；恢复快照核对事件计数、跳过原因、依赖链及 Attempt 终态。执行器不重发该步骤事件，也不重复调用插件，仍按既有 DAG 语义运行其下游；未持久化的步骤继续调度。其他跳过原因仍拒绝自动恢复。
- 对已暂停且原 RunHandle 失联的 Run，显式 resume 命令会先认领控制命令，再尝试获取 Run lease 并校验恢复快照；安全时从已完成步骤后继续，旧事件与步骤不重放。旧 owner 仍持有 lease（含崩溃后尚未过期的 lease）时命令释放认领并保持 pending，由 owner 消费或在 lease 到期后再次尝试；快照不安全时命令明确 rejected。暂停 Run 不纳入后台自动接管扫描，仍需用户主动 resume。
- ready 的 waiting Attempt 已接入恢复扫描：未唤醒时不认领对应 Run；signal 或 timer 标记 ready 后，快照校验 checkpoint 与原 Job/Attempt 身份，执行器沿用同一 Attempt，向插件上下文注入 checkpoint 载荷和可选 wakePayload，成功后继续 DAG。数据库集成测试覆盖未 ready 不抢跑、唤醒后仅一个 Attempt、载荷传递及最终状态。
- 顶层插件步骤可显式声明 `mayWait: true`，插件以成功结果中的 `wait: { checkpoint, condition }` 请求 signal 或 timer 等待。执行器对含可挂起步骤的工作流采用串行 DAG 调度；等待前在有效 Attempt lease 下原子写入 checkpoint/条件并切换 Attempt/Job 为 waiting，释放步骤资源与 Run lease，Run 进入 waiting 且不发出伪造的 `step:finished` 或 `workflow:finished`。唤醒后继续原 Attempt；再次挂起递增 checkpoint version。
- waiting Run 可在无活跃 owner 时持久化取消，Run、Job、Attempt 在数据库事务中一起进入取消态；旧 owner 或恢复器仍持有 Run lease 时取消命令保持 pending，避免与接管竞态。Web 列表和详情页已识别 waiting 为活跃状态。

## 权威边界

- PostgreSQL 是 Run/Attempt lease、Job、Attempt、私有初始 state 和 checkpoint 的权威状态；
- 内存 RunHandle 负责实际控制当前执行；PostgreSQL 控制命令是跨进程请求、认领和完成状态的权威记录；
- lease 绑定 Attempt，checkpoint 绑定 Job 并记录来源 Attempt；
- 任何重试必须使用同一 jobId、新 attemptId 和显式 idempotency key。

## 当前边界

- 终态仍由有序事件链投影，执行前授权已是同步强制闸门；
- 嵌套子执行暂不写 Job/Attempt 表，避免在子 Run 不独立落表时破坏外键和 `(runId, stepId)` 唯一性；
- 后台自动接管覆盖 queued Run、按显式重试策略允许恢复的 timed_out/failed Attempt、条件跳过的已结算分支，以及已 ready 且 checkpoint 有效的 waiting Attempt；paused Run 仅由显式 resume 接管。插件等待条件现可指定 `timeoutAt`：到期后原子标记 Attempt/Job 为 timed_out；有幂等键且仍有重试次数时保持 Run waiting 供恢复扫描创建下一 Attempt，否则同一事务将 Run 结算为 failed。嵌套子工作流挂起、已有失败分支和非条件原因的跳过仍未完成，不能视为整个 Core-2 完成。拒绝原因记录日志，Run 保持原状态并短暂退避，避免阻塞后续可恢复 Run，之后重新校验。
- Run 事件可能裁剪，缺失已完成步骤时拒绝重建；旧 Run 若无私有初始 state 且无已完成 `set_state` 输出也拒绝重建。持久化 idempotency key 与显式 retry policy 是恢复准入条件，但外部副作用仍需插件实际履行幂等契约。
- 插件主动挂起目前只适用于顶层 `mayWait` 步骤；signal/timer 条件可选 `timeoutAt`，但不支持嵌套子工作流挂起。signal 唤醒服务已具备内部接口，面向外部事件/人工审批的授权入口不在本轮范围内。
- 混合版本滚动部署中，旧服务实例不持有 Run lease；启用自动接管前需保证执行节点均升级到本协议，否则旧实例的副作用无法被新 lease 完全约束。
- 控制命令已经跨进程持久化，但当前仍由内嵌 Executor 轮询；远程 Executor 协议留到 Core-3。

## 下一闭环

1. 评估嵌套子工作流的挂起恢复，以及超时失败时补齐与普通执行失败一致的终态事件/结果投影；
2. 支持 paused 时仍在途的步骤与其他可安全续跑的跳过分支恢复，避免历史 Run 长期停留在 active 状态；
3. 扩展故障注入、重复投递和长时间运行测试，并验证插件幂等契约。

本轮条件跳过恢复已通过执行器、快照及 PostgreSQL 端到端接管测试；端到端验证覆盖旧事件不重复、下游只执行一次、最终计数及 SKIPPED Attempt 保持一致。

显式 paused resume 已增加控制命令、快照与 PostgreSQL 端到端测试，覆盖失联后接管、旧步骤不重播、原 owner 仍有效时保持 pending，以及不安全快照拒绝。

顶层插件等待生产端已有执行器单测和 PostgreSQL 端到端测试，覆盖定时唤醒、原 Attempt 续跑、无伪完成事件、资源/lease 释放、重复 checkpoint 版本与 waiting 取消。
