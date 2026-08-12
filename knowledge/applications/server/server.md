---
id: KB-APPLICATION-WORKFLOW-server
type: application
domain: workflow-platform
application: server
appType: "后端应用"
status: DRAFT
sourceType: official
owner: TODO
version: 1
updatedAt: 2026-08-10 00:00:00
lastVerifiedAt: ""
confidence: medium
stability: evolving
evidence:
  - code: apps/server/
  - doc: apps/server/README.md
tags:
  - nestjs
  - prisma
anchors:
  - APPLICATION:server
---

# apps/server（后端服务）

## AI 使用摘要

- 适用场景：HTTP/WebSocket、Run 持久化、工作流 CRUD、引擎进程内接入、插件注册表
- 关键入口：`EngineService`、`RunManager`、Prisma 模型（见包 README）
- 关键规则：**不重写 DAG 编排**；校验 → 落库 → 调 `core-engine` → 事件持久化与推流
- 关联知识：[INDEX.md](./INDEX.md)
- 使用前必须核对：`docs/dev-logs/api-list.md`、环境变量与全局 API 前缀

## 概述

NestJS 服务：把 `@monai-devops/core-engine` 接到 PostgreSQL、REST 与实时推流，托管工作流与插件元数据。

---

## 系统职责

### 核心职责

- HTTP/WS 入参校验与 DTO 序列化（鉴权占位，当前无登录）
- Run 受理、落库、订阅引擎事件、推流、取消/暂停/恢复
- 工作流持久化、导入（reference/copy）、触发运行、校验
- 进程内唯一 `createEngine`；插件注册、资源池、观察者扇出

### 不负责什么

- DAG 并行调度、步骤执行、资源槽位算法（属 `core-engine`）
- 插件 `execute` 业务逻辑（属 `plugins/*`）
- 控制台 UI（属 `web`）

---

## 系统边界

```
[web / 外部客户端] --HTTP/WS--> [server] --createEngine--> [core-engine]
                                      |
                                      v
                                 [PostgreSQL]
```

### 上游依赖

| 系统 | 依赖内容 | 调用方式 |
|------|----------|----------|
| core-engine | 编排执行、事件 | 进程内 import |
| plugin-sdk | 类型与契约 | 进程内 import |
| plugins/* | 已注册插件实现 | 构建时注册表 |

### 下游被依赖

| 系统 | 提供什么 | 提供方式 |
|------|----------|----------|
| web | REST、SSE、WebSocket | HTTP/WS |

---

## 核心模块

| 模块 | 职责 | 文档 |
|------|------|------|
| EngineService | 引擎单例、插件与资源 | 包 README |
| RunManager | Run 生命周期与推流 | 包 README |
| WorkflowsService | 工作流持久化与运行 | 包 README |
| Prisma | Workflow / Run / RunEvent 等 | 包 README |

（核心类/文件路径 TODO：随 domain/base 索引补充）

---

## 变更历史

| 版本 | 日期 | 变更内容 | 变更人 |
|------|------|---------|--------|
| 1 | 2026-08-10 | KB 初稿（边界来自包 README） | — |
