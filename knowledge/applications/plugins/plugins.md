---
id: KB-APPLICATION-WORKFLOW-plugins
type: application
domain: workflow-platform
application: plugins
appType: "脚本"
status: DRAFT
sourceType: official
owner: TODO
version: 1
updatedAt: 2026-08-10 00:00:00
lastVerifiedAt: ""
confidence: medium
stability: evolving
evidence:
  - code: plugins/
  - doc: plugins/README.md
tags:
  - plugin
anchors:
  - APPLICATION:plugins
---

# plugins/ 工作区（业务插件）

## AI 使用摘要

- 适用场景：新建插件包、注册到 server、`pnpm sync:plugins`、试运行与调试
- 关键规则：插件**只依赖** `plugin-sdk`（及自身业务依赖）；禁止逆向依赖 server/web
- 权威操作指南：[plugins/README.md](../../../plugins/README.md)
- 启用列表：`apps/server/plugins.config.json`（易变，改前核对）

## 概述

业务逻辑以独立 npm 包存在于 `plugins/`，由 core-engine 在运行时调度；server 负责注册与元数据暴露。

---

## 系统职责

### 核心职责

- 实现 `PluginDefinition`（经 `createPlugin`）
- 提供 config/result schema 供编排与前端使用
- 通过工作区脚本 `create:plugin`、`sync:plugins` 接入平台

### 不负责什么

- 编排、资源池、Run 持久化
- 控制台 UI

---

## 内置插件（索引入口）

具体包名与用途见根 [README.md](../../../README.md)「当前内置插件」表；新增插件后同步更新 ROUTING 或本页 TODO。

---

## 变更历史

| 版本 | 日期 | 变更内容 | 变更人 |
|------|------|---------|--------|
| 1 | 2026-08-10 | KB 初稿 | — |
