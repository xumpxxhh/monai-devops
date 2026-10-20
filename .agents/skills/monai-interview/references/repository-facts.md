# 仓库核实记录

2026-10-08 核实代码与文档，未执行生产部署或性能测试；以下不是上线证明。路径相对仓库根目录。源码可能更新，易变字段回查。

根 README.md、package.json：pnpm workspace/Turbo/TypeScript；React/Vite 控制台、NestJS/Prisma/PostgreSQL 服务、core-engine 与 plugin-sdk 分离，插件仅依赖 SDK。前端借用类型与纯函数，执行走服务端。

packages/core-engine/README.md 与 executor/、scheduler/、resource/：DAG、Kahn 校验、并发、failFast、资源槽位、等待队列；plugin/set_state/workflow；$ref、子流和受限循环。重试保持 jobId，递增 attempt，生成 attemptId；只自动重试明确 retryable infrastructure/internal 失败。

apps/server/prisma/schema.prisma：Run 包含快照、recoveryState、租约；ExecutionJob 有 runId/stepId 唯一约束，ExecutionAttempt 有消息序号、等待、结果和租约；ExecutionAttemptMessage 以 attemptId/sequence 为键，RunEvent 以 runId/eventIndex 唯一；ExecutorObject 目前是数据库 Bytes、sha256、大小和过期时间，不是 S3 制品库。

apps/server/src/execution/prisma-execution.repository.ts：FOR UPDATE SKIP LOCKED 领取、lease_token 条件更新、序号及接收记录。不能把进程内槽位说成跨机器配额。

apps/server/src/worker/main.ts、worker-client.ts：独立 HTTP Worker、插件白名单、环境变量 Secret 白名单。不是现成的 Docker 任意脚本沙箱。

apps/server/src/execution/worker-identity-policy.ts、worker-transport.controller.ts：Bearer Token 认证、身份插件版本/能力约束，支持一到两个 Token。用户 HTTP/WS 登录与权限不能由此推定。

apps/server/src/execution/executor-capability-policy.ts：插件声明、工作流请求、环境允许列表共同约束，包含 execution.wait、secret.read。apps/server/src/runs/development-run-tenant.ts 仍为 development-only 主体，需要生产租户解析。

apps/server/src/runs/ 有管理、恢复、推送和相关测试；apps/server/src/execution/ 有租约、控制、恢复。具体默认值、错误码、恢复条件回答前回查；测试文件存在不代表本次已运行通过。

apps/web/README.md：React Flow 编辑器、JSON Schema 表单、运行详情，REST/WS、插件试运行 SSE。具体事件归约用 rg 定位 run-state 与 workflow-run-client。

根 README 明确用户侧无内建认证，与 Worker 认证并不矛盾。OIDC、项目 RBAC、GitLab Webhook、审批、环境锁、Harbor、MinIO、Docker CI 隔离、Prometheus 属于模拟补齐，不能声称当前仓库已有实现。

当前 plugins/ 是 test、print、muti-result、model-call、embedding，不能编造 checkout/build/publish/deploy 的源码位置。AI 插件代表通用底座，不代表生产主业务是 AI。

docs/plans/ci-cd-engine/enterprise-ci-cd-roadmap-draft.md 为待评审推演；其引用的 docs/examples/ci-pipeline-poc.workflow.json 本次未找到。路线不是完成证明，当前 execution/worker 比早期路线更完整，以代码核实为准。

调度定位 packages/core-engine/executor/、scheduler/、resource/；插件定位 packages/plugin-sdk/ 与 apps/server/src/plugins/；可靠性定位 prisma-execution.repository.ts、execution-lease.service.ts、execution-recovery.service.ts；Run 恢复定位 run-recovery.service.ts、run-manager.service.ts；控制定位 execution-control.service.ts；Worker 授权定位 worker-identity-policy.ts、executor-capability-policy.ts、worker-transport.controller.ts。
