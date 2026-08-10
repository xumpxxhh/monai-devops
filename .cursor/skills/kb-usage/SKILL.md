---
name: kb-usage
description: >-
  按项目 knowledge 库做路由查阅与候选知识回补。当用户要求查知识库、按 ROUTING 定位、
  kb lookup、知识回补、写入 candidate、或在实现前先梳理应读哪些知识文件时使用。
  不要在纯样式/typo/格式化/单测微调/依赖锁等可跳过场景下主动触发本 skill。
---

# 项目知识库使用（lookup / backfill）

本 Skill 配合仓库内 `knowledge/` 与项目 Rule「知识库使用协议」使用。KB 是稳定语境；**代码与已索引的权威文档才是实现事实**。

## 何时使用 / 何时不用

**使用**：跨模块需求、业务规则/状态/契约、用户点名查 KB 或回补。

**不要使用（直接结束或交给普通编码流程）**：纯样式与文案、单文件 typo/格式化、与业务语义无关的测试微调、依赖锁、用户已给出确切改法且无边界风险的小改动。

若当前任务属于「可跳过」，明确告知「本任务无需读知识库」后停止本 Skill，不要为了走流程而打开 ROUTING。

## 模式 A：lookup（默认）

1. 读取 `knowledge/ROUTING.md`，从用户需求抽取线索（应用名、关键词、接口、状态、Topic 等）。
2. 打开命中的应用 `knowledge/applications/<app>/INDEX.md`，按其中阅读顺序**按需**打开文件；不要全量读 `knowledge/`。
3. 输出简短清单给用户：
   - 已定位的应用 / 入口文件
   - 建议下一步核对的代码路径
   - 仍不确定、需要澄清的点
4. 未经用户要求不要直接大面积改代码；lookup 以「读对上下文」为完成标准。

## 模式 B：backfill

仅在用户要求回补，或本轮已确认存在**稳定、可复用**结论时：

1. 复制 `knowledge/template/candidate.md` 到 `knowledge/candidate/`，填上来源、证据、可信度、待确认项、`suggestedTarget`。
2. `status` 保持 `PENDING_REVIEW`；不要直接写入 `main/` 或 `applications/` 正式正文。
3. 若新增了可检索锚点，提醒（或经用户同意后）在 `knowledge/ROUTING.md` 补一行。

跳过 KB 的小改动默认不做 backfill。

若用户尚不确定「要不要动知识库」，应改走 **kb-iterate**（先 assess，确认后再写 candidate），不要用 backfill 抢跑。

## 禁止

- 把未确认推断写成 OFFICIAL
- 用 KB 中的易变字段替代当前代码核对
- 在未读 ROUTING 的情况下盲扫整个 knowledge 目录
- 对可跳过任务强行 lookup「走个形式」
