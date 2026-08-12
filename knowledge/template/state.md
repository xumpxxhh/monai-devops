---
id: KB-STATE-{DOMAIN}-{SEQ}
type: state                          # 知识对象类型：state
domain: {domain}
application: {appCode}
entity: {entityName}                 # 状态所属的对象，如 order / unit / task
status: DRAFT
sourceType: official
owner: {userId}
version: 1
updatedAt: YYYY-MM-DD HH:MM:SS
lastVerifiedAt: YYYY-MM-DD HH:MM:SS    # 最近一次回代码核对确认的时间，供新鲜度扫描使用
confidence: medium
stability: volatile                  # 状态枚举通常变化较快，默认标 volatile
evidence:
  - code: {枚举定义文件路径}
  - human: {确认人/时间}
tags:
  - {tag1}
anchors:
  - APPLICATION:{appCode}
  - ENTITY:{entityName}
---

# {entityName} 状态生命周期

## AI 使用摘要

- 适用场景：需要判断某个状态码的业务含义、来源字段、进入/离开条件时
- 关键入口：{状态字段所在模型/表}
- 使用前必须核对：**状态枚举值本身变化较快，务必回代码核对当前定义，不要仅信任本文档**

## 证据来源

| 类型 | 来源 | 说明 |
|------|------|------|
| code | {枚举定义文件路径} | {说明} |

---

## 状态定义

| 状态码 | 含义 | 来源字段 | 进入条件 | 离开条件 |
|------|------|----------|----------|----------|
| {STATE_A} | （业务含义） | {model.field} | （何时进入） | （何时离开） |

## 状态流转

（可用文本图或 mermaid 描述状态迁移）

```
{STATE_A} --{触发事件}--> {STATE_B} --{触发事件}--> {STATE_C}
```

## 特殊规则

- {某个状态是否允许跳转/回退}
- {某个状态是否有历史兼容的特殊取值}

## 关联知识

- 相关流程：[flow-xxx.md](./flow-xxx.md)
- 相关规则：[rule-xxx.md](./rule-xxx.md)

## 变更历史

| 版本 | 日期 | 变更内容 | 变更人 |
|------|------|---------|--------|
| 1 | YYYY-MM-DD | 初始版本 | {owner} |
