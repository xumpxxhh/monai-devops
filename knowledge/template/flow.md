---
id: KB-FLOW-{DOMAIN}-{SEQ}
type: flow                           # 知识对象类型：flow
domain: {domain}
application: {appCode}
layer: product                       # product（主干流程）/ solution（差异流程）
solution: {solutionCode}             # 仅 layer=solution 时填写，对应哪个业务身份/线路
status: DRAFT
sourceType: official
owner: {userId}
version: 1
updatedAt: YYYY-MM-DD HH:MM:SS
lastVerifiedAt: YYYY-MM-DD HH:MM:SS    # 最近一次回代码核对确认的时间，供新鲜度扫描使用
confidence: medium
stability: evolving
evidence:
  - code: {核心方法/文件路径}
  - doc: {来源文档}
  - human: {确认人/时间}
tags:
  - {tag1}
anchors:
  - APPLICATION:{appCode}
  - TOPIC:{topicName}
  - API:{apiName}
---

# {流程名称}

## AI 使用摘要

- 适用场景：需要了解「{触发条件}」时，本应用如何处理「{流程一句话描述}」
- 关键入口：{核心类/方法/接口/消息 Consumer}
- 关键规则：{最容易出错或最重要的约束，如「校验必须前置，不能放到异步阶段」}
- 使用前必须核对：状态码枚举、feature key、开关默认值是否有变化

## 证据来源

| 类型 | 来源 | 说明 |
|------|------|------|
| code | {核心方法/文件路径} | {说明} |
| human | {确认人/时间} | {说明} |

---

## 触发条件

（什么情况下会进入这个流程：外部事件 / 用户操作 / 定时任务 / 上游回告等）

## 参与方

| 角色 | 说明 |
|------|------|
| {角色A} | （职责） |

## 流程步骤

```
{步骤1}
  -> {步骤2}
  -> {步骤3（若为异步，需标注 "异步"）}
  -> {步骤4}
```

对每个关键步骤，补充：入口位置（同步/异步）、前置校验、依赖的状态/规则。

## 前置条件 / 后置结果

- 前置条件：{进入本流程前必须满足的条件}
- 后置结果：{流程结束后系统状态的变化}

## 异常与兼容

- 异常情况：{失败/超时/重复触发时如何处理}
- 历史兼容：{是否需要兼容某个历史业务身份/老流程，兼容到什么程度}

## 关联知识

- 状态：[state-xxx.md](./state-xxx.md)
- 规则：[rule-xxx.md](./rule-xxx.md)
- 基础索引：[base/api.md](../base/api.md) / [base/msg.md](../base/msg.md)

## 变更历史

| 版本 | 日期 | 变更内容 | 变更人 |
|------|------|---------|--------|
| 1 | YYYY-MM-DD | 初始版本 | {owner} |
