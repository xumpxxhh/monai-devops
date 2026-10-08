# Core-3 退出验证与回滚手册

> 2026-10-08 状态：仅对默认关闭的非生产 `test-plugin` 远程实验路径完成自动化验证。生产远程执行未获准启用，Core-3 生产退出门槛仍未全部满足。

## 验收证据与缺口

| 门槛 | 现有证据 | 结论 |
| --- | --- | --- |
| 本地路径兼容 | 2026-10-08：server 202/202、core-engine 160/160、Web 47/47；默认仍走 local adapter | 自动化通过；真实旧工作流需人工复测 |
| 远程成功/失败、事件与结果 | `run-remote-http.integration.spec.ts` 的真实 HTTP/PostgreSQL 测试 | 受限插件已覆盖 |
| Worker/HTTP/Run owner 故障、重复回传、旧 lease | 同一集成测试覆盖进程崩溃、重启接管、原序号重连、重复完成和迟到写入 | 受限插件已覆盖 |
| wait/signal、硬取消、Secret 与对象引用 | HTTP/数据库集成测试和 repository 契约测试 | 受限插件已覆盖；取消不撤销已发生外部副作用 |
| 能力授权与 Worker 身份 | 派发前能力检查、命名凭据与报价匹配、lease owner 校验 | 仅实验策略；无 Run 用户/租户主体 |
| 并发容量与长任务稳定性 | lease/deadline/cancel 的单路径测试；尚无可复现的容量、长时 soak 基线 | 未通过生产退出门槛 |
| 人工集成、灰度与回滚演练 | 下方操作清单；尚无真实部署环境演练记录 | 未通过生产退出门槛 |

Run API 的 `RunsController` 没有调用者鉴权入口；`submitRun` 没有可信用户/租户主体，不能把请求体字段当作授权身份。生产启用前须引入服务端验证的 principal，绑定 Run 与租户，按 principal × workflow × requested capability × 环境策略做派发前授权，并覆盖跨租户读取、控制、事件和对象访问的拒绝测试。生产 Worker 凭据、Secret 提供者、对象存储及隔离部署也须独立评审。**不要通过修改环境变量或移除 `remoteTestEnabled()` 中的生产门禁来绕过这些缺口。**

## 非生产集成核对

1. 使用专用测试数据库运行 server 和 core-engine 全套测试，并记录提交号、测试结果和迁移版本；确认 Web 工作流 JSON 导入、编辑、保存回归通过。
2. 在非生产环境、独立 Worker 进程中仅对 `test-plugin` 显式开启 `EXECUTOR_REMOTE_TEST_ENABLED`，配置命名 Worker 身份和最小 capability；核对其它插件仍走本地路径。
3. 分别验证成功、插件失败、等待后 signal、取消、deadline、Worker 断线、HTTP 入口重启、Run owner 重启；比对 Run/Job/Attempt 的终态、事件顺序与重复投影。对一个旧版工作流执行本地前后对照。
4. 核查日志、Run JSON、事件和对象引用不含 Secret 明文；验证无权 Worker 不能领取、回传或读取其它 Worker 的对象。记录并发运行数、领取等待、lease 过期、重试、fence 拒绝和对象清理结果。
5. 长任务和并发压测应在隔离环境给出负载、持续时间、故障注入、延迟分布及资源上限；当前没有可引用的通过记录，不能以单次集成测试替代。

## 分阶段开启与回滚

目前仅允许非生产 `test-plugin` 实验：先部署兼容数据库迁移和新 server，保持远程开关关闭；再部署命名 Worker，核对协议版本、凭据和报价；最后在隔离环境打开实验开关，观察上述指标。每一阶段都要保留旧本地路径，并记录启停时间与运行中的 Attempt。

回滚时先禁止新的远程派发（关闭 `EXECUTOR_REMOTE_TEST_ENABLED` 并滚动重启 server），不要立即撤销仍在运行的 Worker 凭据。等待已领取 Attempt 完成、进入 waiting，或在 lease/deadline 到期后由持有 Run lease 的 server 结算；检查无 queued/running 的远程 Attempt 后再停 Worker、撤销旧凭据。不要删除 Attempt、Job、事件或对象记录，也不要回退已使用的数据库迁移。若必须强制停止 Worker，按 Core-2 恢复机制等待旧 lease 失效，复核外部副作用的幂等性；平台 fencing 无法撤销已发生的外部调用。

生产灰度的准入条件是补齐上节授权和基础设施缺口、跑完并发/长时验证、在实际部署环境完成上述人工演练并记录结果。在此前，Core-3 只能标记“非生产实验闭环”，不能标记“生产完成”。
