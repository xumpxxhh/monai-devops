# Core-3：Executor 与能力边界（实施规划草案）

> 状态：3.0–3.4 的受限非生产 `test-plugin` 实验闭环已完成。3.5 的自动化故障验证与运维退出清单见[退出验证和回滚手册](./core-3-exit-verification.md)；人工灰度验收、Run 用户身份/多租户授权和生产密钥治理未完成，因此 **Core-3 尚不能按生产标准关闭，生产远程执行继续禁用**。

3.3 实验路径已接入 capability 派发授权与 worker 领取匹配：插件 manifest 声明可用能力，步骤以 `requestedCapabilities` 请求（`mayWait` 隐含请求 `execution.wait`），server 与 `EXECUTOR_ALLOWED_CAPABILITIES` 环境允许列表取交集；未声明或未允许的能力在派发前失败，并通过步骤失败事件及服务日志记录原因。该字段已贯通 HTTP DTO、工作流草稿、JSON 导入与编辑器再次保存。worker 领取时上报插件名称/版本/能力，数据库只分配匹配的 queued Attempt，资源可用性不代替授权。命名 Worker 凭据可将身份绑定到允许的插件报价，消息回传再校验当前 Attempt 的 lease owner；双 token 配置支持先增加新凭据、切换 worker、再撤销旧凭据。本地 adapter 显式标记为可信进程，不声称沙箱隔离。此轮仍限非生产 `test-plugin`，共享 bearer 只保留实验兼容；Run 用户身份与多租户策略、Secret 授权和生产凭据管理尚未完成，不能宣称生产级 3.3 完成。

> 基线：[共享内核前置提案](./shared-core-engine-prerequisites-draft.md)；依赖：[Core-2 可靠调度与恢复](./core-2-reliable-execution-foundation.md)。

3.4 的非生产闭环：server 对远程 Attempt 签发绝对 `deadlineAt`，默认 5 分钟，可通过 `EXECUTOR_ATTEMPT_DEADLINE_MS` 配置在 10 秒至 24 小时之间；worker 到点中止插件，数据库 CAS 拒绝迟到写入。hard cancel 默认零宽限并立即 fence，可显式设置 `EXECUTOR_CANCEL_GRACE_MS`（0–30000）先向 Worker 返回 `cancel_requested`，到期由数据库时钟驱动的扫描器 fence Attempt/Job。已完成的外部副作用仍不可撤销。

3.4 受限日志已落地：实验传输只接受版本 1 的 `plugin:log` 事件及固定字段，内联日志最长 4096 字符，每个 Attempt 最多 100 条。更长日志由 Worker 上传受权对象，事件仅保留引用；超过 1 MiB 的单条日志截断到上限。server 在持久化前独立验证并以数据库内已有事件计数限制总量，超额拒绝为 `payload_too_large`。Secret 值在 Worker 端对直接日志输出脱敏；不承诺抵御恶意插件的编码或变形泄露。

Secret 与对象治理也已接入这条受限路径：插件步骤的 `secretRefs` 只接受 `secret://env/NAME`，隐含请求 `secret.read`；插件声明、环境策略及命名 Worker 报价均须批准。值仅由 Worker 自身环境变量白名单解析，直接输出到日志会被替换为 `[REDACTED]`，直接包含值的结果被拒绝并改为通用失败。超过 64 KiB 的结果或 4096 字符的日志上传至 Attempt/Worker 绑定的 PostgreSQL 对象记录，Run/事件只保存版本化 `ObjectRef`；读取需要同一命名 Worker 凭据。对象限 1 MiB、保留 7 天，启动时及每小时清理过期记录；小结果与短日志继续内联。公共 Run API 没有用户级鉴权，因此不开放对象读取。这里不承诺抵御同进程恶意插件对 Worker 环境或凭据的主动窃取，也不把此试验实现作为生产 Secret 管理。

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

3.0 契约、消息示例、限额及权威边界见 [Executor 协议 v1](./core-3-executor-protocol-v1.md)。持久化 CAS、HTTP worker、试验选路和非生产故障集成验证已落地；生产信任边界仍待完成。

## 单步闭环顺序

| 步骤             | 本步交付                                                                                                  | 验收门槛                                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 3.0 协议定稿     | `ExecutorAdapter`/请求/结果/事件/控制契约；Run 与 Attempt lease 所有权、错误码、版本兼容和威胁模型        | 合约测试覆盖重复、迟到、旧 token、超时、取消及 wait；评审确认传输与信任边界                                               |
| 3.1 本地适配     | 当前插件管理器包入 local adapter；server 的顶层插件步骤通过统一接口执行                                   | 现有工作流 JSON、事件、重试、等待、控制和 Web 行为不变；全量回归通过，可回退到旧路径                                      |
| 3.2 最小远程闭环 | 独立 worker 进程、领取/续租、事件/结果回传、取消、超时、等待；按工作流或环境显式选路                      | 两进程 PostgreSQL 集成测试：成功、失败、worker/server 崩溃、重领竞争、重复完成、远程等待唤醒；旧 token 无法产生副作用投影 |
| 3.3 能力与权限   | 插件声明所需 capability；工作流请求、运行身份、环境策略与 worker 提供能力做交集授权；资源可用性与授权分开 | 默认拒绝未声明的网络/文件/Secret 能力；授权失败发生在派发前，审计记录原因；本地 adapter 明确标记为可信而非假装沙箱        |
| 3.4 数据与治理   | deadline/取消宽限期、受限事件与日志、Secret 引用解析、较大结果/日志的对象引用接口                         | 无明文 Secret 落库/出现在事件；大对象超阈值不进入 Run JSON；引用可鉴权读取并有保留/清理策略；旧小结果兼容                 |
| 3.5 退出验证     | 故障注入、兼容性、并发和长任务测试；分阶段开启与回滚手册                                                  | 本地路径回归无差异；远程路径达到下述退出标准并经人工集成验证                                                               |

进度：3.0 已实现类型、拒绝码和契约测试，生产传输/信任边界留待 3.3/3.4；3.1 已将默认引擎插件调用接入可信进程内 local adapter，并保留兼容入口。3.2 已完成默认关闭的非生产 `test-plugin` 最小远程闭环：server 在 Run lease 下登记不可变、白名单裁剪的 dispatch；独立 worker 经 bearer HTTP 领取、续租、顺序回传受限日志、完成或等待；数据库以 CAS 结算 Attempt/Job，DAG 消费持久化收据。远程 wait 的 checkpoint/条件原子保存，signal 唤醒后创建下一 Attempt。worker 失联由持有 Run 的 server 超时结算；server 失联由新 owner 接管，已落库结果与日志幂等补投影。硬取消会 fence Attempt/Job 和迟到消息，但不回滚外部副作用。其它插件及生产环境保持本地执行；这里不声称 worker 具有沙箱隔离或生产 Secret 能力。

每步合并时同时提交代码、迁移/配置示例、契约及集成测试、本文进度记录；不先建空协议或大规模抽象而长期没有可运行闭环。

验证记录：test DB 已通过真实 HTTP 领取与回传、独立 worker 进程成功执行及崩溃超时、旧 token 拒绝、Run lease 接管后的完成结果幂等补投影、HTTP 完成响应丢失后的同序号去重。新增同一 HTTP/数据库链路的失败、日志、远程 wait/signal/新 Attempt、硬取消与迟到完成拒绝、持续断线后的原序号重连测试。故障注入还覆盖独立 HTTP 传输进程重启，以及持有 Run 的服务进程与 HTTP 入口同时重启后由新进程接管、同一 Attempt 完成并只投影一次。后者暴露的暂态恢复固定延后 30 秒问题已修复为按恢复轮询间隔重试。

命名 worker 认证和轮换配置、受限 Secret 引用与大对象治理已加入实验路径；Run 用户身份绑定、多租户授权及生产密钥管理仍未完成，不能据此宣称生产可用。3.2/3.4 的“完成”均指默认关闭、受限 `test-plugin` 的非生产闭环；并不代表已开放通用插件或生产环境。

## 关键设计约束

- **资源不等于权限**：资源池回答“有没有可用槽位/能力”，策略回答“这个 Run 能不能用”。两者均满足才派发。不要把网络或 Secret 权限仅表示成资源名称。
- **执行隔离必须真实**：local adapter 沿用可信宿主语义；只有独立 worker 的进程/容器边界可以声称隔离。第一版至少限制输入、输出、日志大小及可访问 capability，不承诺抵御恶意宿主管理员。
- **Secret 只传引用**：由受权 worker 在执行时短期解析、内存使用，日志/错误统一脱敏；不能用现有任意 `context`/`metadata` 字段透传明文。Secret 的外部来源在 3.0 决定，先不绑定特定供应商。
- **大对象渐进迁移**：结构化小结果仍可内联；定义版本化 `ObjectRef`（类型、大小、摘要、位置、保留期），先实现一个可替换的存储适配器，再给日志和结果设置阈值。不得把本地绝对路径作为跨 worker 引用。
- **幂等是端到端契约**：Attempt fencing 只能阻止旧 worker 改写平台状态，不能撤销它已调用的外部 API；可重试插件仍必须履行幂等键约定，Core-4 用真实副作用测试验证。
- **兼容与回滚**：默认继续本地执行；远程选路显式开启。数据库迁移先兼容旧服务读写，协议版本不兼容的 worker 不领取任务。回滚不丢失已领取的 Attempt，需等待完成或租约到期后按 Core-2 恢复。

## 阶段退出标准

Core-3 完成的判据不是“能从远程调用一次插件”，而是：相同工作流在 local/remote 两条路径下有一致的 Job/Attempt、结果和事件语义；worker 断线、server 重启、重复投递、取消及等待能安全结算；未授权能力和旧 lease 写入被拒绝；Secret 与大对象不泄漏到 Run JSON；有可操作的灰度、观测和回滚路径。

## 后续生产化决策（不属于已完成的实验闭环）

1. 首个 worker 的信任等级与部署方式：独立本机进程、容器，还是现有集群节点？这决定隔离声明和默认 capability。
2. HTTP 长轮询是否作为首版传输；worker 身份由哪套现有认证体系签发，如何轮换/撤销？
3. 初版 Secret 来源与对象存储适配器使用项目现有设施，还是先提供本地开发实现与生产接口？
4. 远程选路的配置粒度及回滚开关：环境级还是工作流级；是否允许同一工作流混合 local/remote 插件步骤？首版建议环境级显式开启，避免调度语义骤增。

前述实验路径选用了独立进程、HTTP 长轮询、命名 Worker 凭据、环境 Secret 与 PostgreSQL 对象记录，但这些选型仅供非生产验证。生产化必须先确定 Run 调用者身份与租户授权、Worker 凭据和 Secret 来源、对象存储及灰度部署方案；不得把实验实现直接作为生产授权与隔离承诺。
