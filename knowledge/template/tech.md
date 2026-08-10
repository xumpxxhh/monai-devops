---
id: KB-TECH-{DOMAIN}-{SEQ}
type: tech                           # 知识对象类型：tech
domain: {domain}
application: {appCode}
category: architecture-constraint    # architecture-constraint / framework / error-handling / scheduler / transaction / mq / pitfall
status: DRAFT
sourceType: official
owner: {userId}
version: 1
updatedAt: YYYY-MM-DD HH:MM:SS
lastVerifiedAt: YYYY-MM-DD HH:MM:SS    # 最近一次回代码核对确认的时间，供新鲜度扫描使用
confidence: medium
stability: stable
evidence:
  - code: {相关代码路径}
  - human: {确认人/时间}
tags:
  - {tag1}
anchors:
  - APPLICATION:{appCode}
---

# {技术知识标题}

## AI 使用摘要

- 适用场景：写代码/做方案设计涉及「{什么场景}」时必须遵守
- 关键入口：{相关代码路径/配置}
- 关键规则：{一句话总结最重要的约束}

## 证据来源

| 类型 | 来源 | 说明 |
|------|------|------|
| code | {相关代码路径} | {说明} |

---

## 背景

（为什么会有这条技术约束：历史原因/架构决策/事故复盘）

## 规则内容

（具体要遵守什么，写成可执行的检查项）

- {规则1}
- {规则2}

## 反例

（违反这条约束会导致什么问题，最好给出真实或典型的错误写法）

## 适用范围

（哪些模块/场景必须遵守，哪些场景不适用）

## 关联知识

- 相关应用：[application.md](../application.md)
- 相关流程：[flow-xxx.md](../domain/product/flow-xxx.md)

## 变更历史

| 版本 | 日期 | 变更内容 | 变更人 |
|------|------|---------|--------|
| 1 | YYYY-MM-DD | 初始版本 | {owner} |
