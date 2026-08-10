---
id: KB-RULE-{DOMAIN}-{SEQ}
type: rule                           # 知识对象类型：rule
domain: {domain}
application: {appCode}
scope: application                   # 适用范围：global（对应 main/）/ application / solution
solution: {solutionCode}             # 仅 scope=solution 时填写
status: DRAFT
sourceType: official
owner: {userId}
version: 1
updatedAt: YYYY-MM-DD HH:MM:SS
lastVerifiedAt: YYYY-MM-DD HH:MM:SS    # 最近一次回代码核对确认的时间，供新鲜度扫描使用
confidence: medium
stability: evolving
evidence:
  - code: {规则实现位置}
  - human: {确认人/时间}
tags:
  - {tag1}
anchors:
  - APPLICATION:{appCode}
  - RULE:{ruleName}
---

# {规则名称}

## AI 使用摘要

- 适用场景：需要判断「{什么样的输入/条件}」应该「{怎样处理}」时
- 关键入口：{规则实现的核心方法/配置}
- 使用前必须核对：开关/配置项的当前默认值

## 证据来源

| 类型 | 来源 | 说明 |
|------|------|------|
| code | {规则实现位置} | {说明} |

---

## 规则描述

（一句话说明规则本身：什么条件下，做什么判断/限制）

## 触发条件

（什么输入/场景会命中这条规则）

## 例外情况

（哪些情况不适用这条规则，或有特殊处理）

## 历史兼容

（是否需要兼容某个历史业务身份/老逻辑，兼容到什么程度，未来是否计划收敛）

## 关联知识

- 相关流程：[flow-xxx.md](./flow-xxx.md)
- 相关状态：[state-xxx.md](./state-xxx.md)

## 变更历史

| 版本 | 日期 | 变更内容 | 变更人 |
|------|------|---------|--------|
| 1 | YYYY-MM-DD | 初始版本 | {owner} |
