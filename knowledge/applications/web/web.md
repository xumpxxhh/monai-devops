---
id: KB-APPLICATION-WORKFLOW-web
type: application
domain: workflow-platform
application: web
appType: "前端应用"
status: DRAFT
sourceType: official
owner: TODO
version: 1
updatedAt: 2026-08-10 00:00:00
lastVerifiedAt: ""
confidence: medium
stability: evolving
evidence:
  - code: apps/web/
  - doc: apps/web/README.md
tags:
  - react
  - vite
anchors:
  - APPLICATION:web
---

# apps/web（控制台）

## AI 使用摘要

- 适用场景：工作流可视化编辑、运行监控、插件试运行、资源队列查看
- 关键入口：路由、`WorkflowRunClient`、共享 UI（见包 README）
- 关键规则：执行与权威状态走 **server**；前端复用 `core-engine` 类型与纯函数（如 DAG/`$ref` 校验）
- 关联知识：[INDEX.md](./INDEX.md)
- 使用前必须核对：`DEVOPS_API_BASE_URL` 与后端 `GLOBAL_API_PREFIX`

## 概述

React + Vite 控制台，通过 REST + WebSocket 对接 `apps/server`。

---

## 系统职责

### 核心职责

- 工作流 DAG 编辑与校验展示
- Run 详情、日志与实时订阅
- 插件列表、schema 展示与试运行
- 资源/队列相关视图（以 server 数据为准）

### 不负责什么

- 工作流持久化与引擎执行（server + core-engine）
- 插件运行时逻辑（plugins）

---

## 系统边界

```
[用户浏览器] --> [web] --REST/WS--> [server] --> [core-engine]
```

---

## 变更历史

| 版本 | 日期 | 变更内容 | 变更人 |
|------|------|---------|--------|
| 1 | 2026-08-10 | KB 初稿 | — |
