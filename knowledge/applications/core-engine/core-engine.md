---
id: KB-APPLICATION-WORKFLOW-core-engine
type: application
domain: workflow-platform
application: core-engine
appType: "服务"
status: DRAFT
sourceType: official
owner: TODO
version: 1
updatedAt: 2026-08-10 00:00:00
lastVerifiedAt: ""
confidence: medium
stability: evolving
evidence:
  - code: packages/core-engine/
  - doc: packages/core-engine/README.md
tags:
  - dag
  - scheduler
anchors:
  - APPLICATION:core-engine
---

# @monai-devops/core-engine

## AI 使用摘要

- 适用场景：DAG 调度、步骤执行、资源槽位、Run 取消/暂停/恢复、观察者事件
- 关键入口：`createEngine` 及 engine / executor / scheduler / resource / plugin 子模块
- 关键规则：插件失败以 `PluginResult` 表达；依赖 `plugin-sdk` 契约，**不**持久化业务数据
- 关联知识：[INDEX.md](./INDEX.md)

## 概述

内存中按 DAG 调度步骤、执行插件、管理资源，并发出 Run 生命周期事件。

---

## 系统职责

| 层 | 职责 |
|---|---|
| engine | 门面：资源钩子、workflow 入队、`cancelRun` |
| executor | DAG 校验、并行调度、步骤执行、观察者 |
| plugin | 注册表与 execute 包装 |
| scheduler | workflow 级优先级与并发 |
| resource | 按 `resourceType` 抢槽位 |
| observer | 事件类型与 `WorkflowObserver` |

### 不负责什么

- HTTP/WS、数据库（server）
- 插件包业务逻辑（plugins）
- 插件契约定义（plugin-sdk，但 engine 消费该契约）

---

## 变更历史

| 版本 | 日期 | 变更内容 | 变更人 |
|------|------|---------|--------|
| 1 | 2026-08-10 | KB 初稿 | — |
