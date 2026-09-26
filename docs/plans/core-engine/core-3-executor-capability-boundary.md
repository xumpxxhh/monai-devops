# Core-3：Executor 与能力边界（实施规划草案）

> 状态：逐步实施中；3.0 的传输无关契约候选与测试已落地，尚未接入运行路径。远程传输、认证和部署方式仍待评审。
>
> 基线：[共享内核前置提案](./shared-core-engine-prerequisites-draft.md)；依赖：[Core-2 可靠调度与恢复](./core-2-reliable-execution-foundation.md)。

## 目标与范围

Core-3 要把“宿主进程直接调用插件”变成有明确身份、执行权、权限和数据边界的 Executor 协议。第一版仍由 server 持有顶层 Run lease 并编排 DAG；本地或远程 Executor 只运行**顶层插件步骤的一个 Attempt**。`set_state`、子工作流编排、条件判断和恢复快照仍留在 server/core-engine，不在第一版远程化。

```text
server：Run lease + DAG + 控制命令 + 权威投影
  └─ dispatch(Job, Attempt, policy, input refs)
       ├─ local adapter → 当前插件管理器（可信宿主进程）
       └─ remote adapter → worker（独立进程，受限 capability）
                         └─ claim / heartbeat / event / complete | wait
PostgreSQL：Job/Attempt、lease、checkpoint、事件与控制命令的权威状态
```

不把 CI 的 Runner、制品/部署模型或 Agent 的 Tool/Memory/模型供应商写入共享内核。远程容器编排平台、多租户计费和生产级密钥管理产品不在首个远程闭环内。

## 协议与权威规则

1. `ExecutionRequest` 至少包含 `runId/jobId/attemptId`、步骤/插件与版本、幂等键、输入引用、追踪 ID、deadline、所需 capability 和策略版本。敏感值不放进请求、Run JSON、事件或日志。
2. worker 以服务端授予的短期凭证领取 Attempt；Attempt lease token 对 heartbeat、事件、checkpoint、`complete`、`wait` 和控制确认全程加闸。过期或旧 token 的写入必须拒绝；重复完成按 `(attemptId, token, terminal transition)` 幂等处理。
3. server 的 Run lease 与 worker 的 Attempt lease 职责分离：server 失联后由 Core-2 接管 Run；worker 失联后 Attempt 超时并按既有 retry/idempotency 策略处理。不能因为重新投递就复用已终结的 Attempt。
4. 插件可返回成功、分类失败或持久化 `wait`。远程 `wait` 必须由服务端在同一数据库事务校验 token、保存 checkpoint、切换 Attempt/Job 为 waiting；不能先答复 worker 成功而数据库仍处于 running。
5. 事件包含 Attempt 身份、递增序号、payload 版本和时间戳。服务端负责持久化与回放；迟到、重复、越权或超限的事件不进入 Run 事件流。取消为协作请求；超过宽限期后 fence 后续写入，不宣称能回滚已发生的外部副作用。

协议字段和状态转换先形成类型、示例消息、错误码、兼容版本与测试向量，再选择具体传输。首版建议 worker 经受权 HTTP 长轮询向 server 领取任务并回传事件；worker 不直接连接 PostgreSQL。后续可替换传输，不改变上述权威语义。

3.0 契约候选、消息示例、限额及权威边界见 [Executor 协议 v1](./core-3-executor-protocol-v1.md)。当前仅有纯预检，没有持久化 CAS 或 worker 实现。

## 单步闭环顺序

| 步骤             | 本步交付                                                                                                  | 验收门槛                                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 3.0 协议定稿     | `ExecutorAdapter`/请求/结果/事件/控制契约；Run 与 Attempt lease 所有权、错误码、版本兼容和威胁模型        | 合约测试覆盖重复、迟到、旧 token、超时、取消及 wait；评审确认传输与信任边界                                               |
| 3.1 本地适配     | 当前插件管理器包入 local adapter；server 的顶层插件步骤通过统一接口执行                                   | 现有工作流 JSON、事件、重试、等待、控制和 Web 行为不变；全量回归通过，可回退到旧路径                                      |
| 3.2 最小远程闭环 | 独立 worker 进程、领取/续租、事件/结果回传、取消、超时、等待；按工作流或环境显式选路                      | 两进程 PostgreSQL 集成测试：成功、失败、worker/server 崩溃、重领竞争、重复完成、远程等待唤醒；旧 token 无法产生副作用投影 |
| 3.3 能力与权限   | 插件声明所需 capability；工作流请求、运行身份、环境策略与 worker 提供能力做交集授权；资源可用性与授权分开 | 默认拒绝未声明的网络/文件/Secret 能力；授权失败发生在派发前，审计记录原因；本地 adapter 明确标记为可信而非假装沙箱        |
| 3.4 数据与治理   | deadline/取消宽限期、受限事件与日志、Secret 引用解析、较大结果/日志的对象引用接口                         | 无明文 Secret 落库/出现在事件；大对象超阈值不进入 Run JSON；引用可鉴权读取并有保留/清理策略；旧小结果兼容                 |
| 3.5 退出验证     | 故障注入、兼容性、并发和长任务测试；分阶段开启与回滚手册                                                  | 本地路径回归无差异；远程路径达到下述退出标准并经人工集成验证                                                              |

进度：3.0 的类型、拒绝码和契约测试已实现；传输与信任边界决策未定，故尚不视为完整验收。3.1 已将默认引擎的插件调用接入可信进程内 local adapter，并保留直接构造执行器的 `pluginExecutor` 兼容入口。进程内 logger、取消信号等仍以原对象传递，不经过远程 JSON 协议；现有步骤结算、等待、事件及资源钩子不变。3.2 已完成四个内部子步：Attempt 领取/启动/续租 fencing；心跳/事件 inbox 与序号 CAS；`complete`/`wait` 的 Attempt/Job 原子结算；server 恢复取得 Run 独占 lease 后，对已结算但尚未投影的 worker 完成结果幂等补写 `step:finished` 和 Run 计数，再交给既有 DAG 快照恢复。数据库时钟约束租约和 deadline，已测试重复、跳号、旧 token、过期、并发与崩溃窗口。实时远程适配器尚未把结果交回运行中的 DAG；远程 wait 尚未同步 Run waiting 状态，故仍不能开放经过认证的 worker 传输或显式选路，也不能视作远程闭环。

每步合并时同时提交代码、迁移/配置示例、契约及集成测试、本文进度记录；不先建空协议或大规模抽象而长期没有可运行闭环。

## 关键设计约束

- **资源不等于权限**：资源池回答“有没有可用槽位/能力”，策略回答“这个 Run 能不能用”。两者均满足才派发。不要把网络或 Secret 权限仅表示成资源名称。
- **执行隔离必须真实**：local adapter 沿用可信宿主语义；只有独立 worker 的进程/容器边界可以声称隔离。第一版至少限制输入、输出、日志大小及可访问 capability，不承诺抵御恶意宿主管理员。
- **Secret 只传引用**：由受权 worker 在执行时短期解析、内存使用，日志/错误统一脱敏；不能用现有任意 `context`/`metadata` 字段透传明文。Secret 的外部来源在 3.0 决定，先不绑定特定供应商。
- **大对象渐进迁移**：结构化小结果仍可内联；定义版本化 `ObjectRef`（类型、大小、摘要、位置、保留期），先实现一个可替换的存储适配器，再给日志和结果设置阈值。不得把本地绝对路径作为跨 worker 引用。
- **幂等是端到端契约**：Attempt fencing 只能阻止旧 worker 改写平台状态，不能撤销它已调用的外部 API；可重试插件仍必须履行幂等键约定，Core-4 用真实副作用测试验证。
- **兼容与回滚**：默认继续本地执行；远程选路显式开启。数据库迁移先兼容旧服务读写，协议版本不兼容的 worker 不领取任务。回滚不丢失已领取的 Attempt，需等待完成或租约到期后按 Core-2 恢复。

## 阶段退出标准

Core-3 完成的判据不是“能从远程调用一次插件”，而是：相同工作流在 local/remote 两条路径下有一致的 Job/Attempt、结果和事件语义；worker 断线、server 重启、重复投递、取消及等待能安全结算；未授权能力和旧 lease 写入被拒绝；Secret 与大对象不泄漏到 Run JSON；有可操作的灰度、观测和回滚路径。

## 进入 3.0 前须定的决策

1. 首个 worker 的信任等级与部署方式：独立本机进程、容器，还是现有集群节点？这决定隔离声明和默认 capability。
2. HTTP 长轮询是否作为首版传输；worker 身份由哪套现有认证体系签发，如何轮换/撤销？
3. 初版 Secret 来源与对象存储适配器使用项目现有设施，还是先提供本地开发实现与生产接口？
4. 远程选路的配置粒度及回滚开关：环境级还是工作流级；是否允许同一工作流混合 local/remote 插件步骤？首版建议环境级显式开启，避免调度语义骤增。

在这些选择评审前，可以先实现不依赖部署厂商的 3.0 合约与 3.1 本地适配；不得提前把认证、Secret 或存储方案写死在 core-engine。
