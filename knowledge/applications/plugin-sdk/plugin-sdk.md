---
id: KB-APPLICATION-WORKFLOW-plugin-sdk
type: application
domain: workflow-platform
application: plugin-sdk
appType: "服务"
status: DRAFT
sourceType: official
owner: TODO
version: 1
updatedAt: 2026-08-10 00:00:00
lastVerifiedAt: ""
confidence: medium
stability: stable
evidence:
  - code: packages/plugin-sdk/
  - doc: packages/plugin-sdk/README.md
tags:
  - plugin
  - zod
anchors:
  - APPLICATION:plugin-sdk
---

# @monai-devops/plugin-sdk

## AI 使用摘要

- 适用场景：编写或审查插件契约、`createPlugin`、config/result schema、协作取消
- 关键约定：`execute` 用 `PluginResult` 表成败；取消用 `AbortSignal` + `PluginCancelledError`
- 关键规则：**不负责**注册表与调度（core-engine / server）
- 关联知识：[INDEX.md](./INDEX.md)

## 概述

插件作者面向的契约与辅助工具（zod schema、logger、sleep、throwIfAborted 等）。

---

## 核心约定（摘要）

1. 业务失败 → `{ success: false }`，不靠 throw 表示步骤失败
2. 取消协作式；`createPlugin` 将取消收成 `PLUGIN_CANCELLED`
3. `configSchema` 运行时校验；`resultSchema` 主要供前端与 `$ref` 静态校验

### 不负责什么

- 插件注册、DAG 执行（core-engine）
- 插件 HTTP 暴露（server）

---

## 变更历史

| 版本 | 日期 | 变更内容 | 变更人 |
|------|------|---------|--------|
| 1 | 2026-08-10 | KB 初稿 | — |
