---
id: KB-APPLICATION-{DOMAIN}-{SEQ}
type: application                    # 知识对象类型：application
# 业务归属
domain: {domain}                     # 业务域
application: {appCode}               # 应用编码
appType: "{前端应用 | 后端应用 | 服务 | 脚本}"  # 供工具自动识别（如后端应用触发接口安全检查）
# 状态管理
status: DRAFT                        # DRAFT/CANDIDATE/OFFICIAL/DEPRECATED
sourceType: official                 # 来源：official/ai-assisted/personal
owner: {userId}                      # 负责人
version: 1                           # 版本号
updatedAt: YYYY-MM-DD HH:MM:SS        # 更新时间
lastVerifiedAt: YYYY-MM-DD HH:MM:SS    # 最近一次回代码核对确认的时间，供新鲜度扫描使用
confidence: medium                   # high/medium/low
stability: evolving                  # stable/evolving/volatile
evidence:
  - code: {核心模块或仓库路径}
  - doc: {应用文档或系统说明}
  - human: {确认人/时间}
# 标签与锚点
tags:
  - {tag1}
  - {tag2}
anchors:
  - APPLICATION:{appCode}
  - BIZ_IDENTITY:{identity1}
---

# {应用名称}

## AI 使用摘要

- 适用场景：需要了解 `{appCode}` 的系统职责、边界、上下游、核心模块时
- 关键入口：{核心接口/消息/启动模块}
- 关键规则：{本应用最重要的边界或约束}
- 关联知识：[INDEX.md](./INDEX.md)
- 使用前必须核对：应用代码路径、核心接口、消息 Topic 是否有近期变更

## 证据来源

| 类型 | 来源 | 说明 |
|------|------|------|
| code | {核心模块或仓库路径} | {代码核对说明} |
| doc | {应用文档或系统说明} | {文档来源说明} |
| human | {确认人/时间} | {人工确认说明} |

## 概述

（一句话描述这个应用是做什么的）

---

## 基本信息

| 属性 | 值 |
|------|-----|
| 应用编码 | {appCode} |
| 应用名称 | {应用名称} |
| 所属团队 | {团队名称} |
| 负责人 | {owner} |
| 技术栈 | {技术栈} |

---

## 系统职责

### 核心职责

（描述这个应用的核心职责）

### 业务范围

（描述负责的业务范围）

### 不负责什么

（明确边界，避免与其他系统混淆）

---

## 系统边界

（可以用文本图表示系统边界）

```
[上游系统A] ──┐
[上游系统B] ──┼──> [本应用] ──> [下游系统X]
[上游系统C] ──┘                └──> [下游系统Y]
```

### 上游依赖

| 系统 | 依赖内容 | 调用方式 |
|------|----------|----------|
| {系统A} | （依赖什么） | RPC/MQ/HTTP |

### 下游被依赖

| 系统 | 提供什么 | 提供方式 |
|------|----------|----------|
| {系统X} | （提供什么） | RPC/MQ/HTTP |

---

## 核心模块

| 模块 | 职责 | 核心类/文件 | 文档 |
|------|------|--------|------|
| {模块A} | （职责） | （核心类/文件） | - |

---

## 变更历史

| 版本 | 日期 | 变更内容 | 变更人 |
|------|------|---------|--------|
| 1 | YYYY-MM-DD | 初始版本 | {owner} |
