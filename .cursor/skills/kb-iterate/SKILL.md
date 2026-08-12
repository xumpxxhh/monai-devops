---
name: kb-iterate
description: >-
  显式触发的知识库迭代评估：先 assess（只读）判断是否需要迭代并给出提案，
  经用户确认后再 apply，默认只写入 knowledge/candidate/。
  当用户说「评估知识库要不要迭代」「KB 迭代评估」「kb assess」
  「评估本次是否要回补知识库」「按提案写入 candidate」时使用。
  不要在用户未要求时自动评估；不要在未确认时写入 knowledge/；
  不要默认修改 official 或 ROUTING。
---

# 知识库 AI 迭代（assess / apply）

配合仓库 `knowledge/`。协议详见 `knowledge/README.md`（AI 迭代维护小节）。

## 硬约束

1. **仅显式触发** assess；禁止交付后/定时自动评估。  
2. **确认前零写入** `knowledge/`。  
3. **apply 默认只写** `knowledge/candidate/`（用 `knowledge/template/candidate.md`）。  
4. 未经用户逐项批准，禁止：改 official、`ROUTING.md`、升格 OFFICIAL、DEPRECATED、删文件。

## 模式 A：assess（默认）

1. 确定范围：用户说明 > 当前对话结论 > 可得的 git diff/status 摘要。  
2. 读 `knowledge/ROUTING.md` → 相关应用 INDEX → 必要正式知识；查看 `candidate/` 是否重复。  
3. 可选：运行 `knowledge/scripts` 检查作信号，不代替判断。  
4. 输出：`需要迭代 | 不必迭代 | 建议关注` + 理由 + 提案表（ID / 动作 / candidate 路径 / 证据 / 置信度）。  
5. 明确列出「默认不会做」的项，并等待用户确认。**到此为止，不写文件。**

## 模式 B：apply

仅当用户明确批准（整单或指定提案 ID）后：

1. 只执行已批准项。  
2. 写入 `knowledge/candidate/`，`status: PENDING_REVIEW`，补齐来源与证据。  
3. 汇报写入路径；提醒需 owner review 后才能进 official。  
4. 若用户额外批准了 ROUTING/official 等，再单独执行并在汇报中标明。

## 何时不必迭代

纯样式/文案/typo、无复用价值的一次性改动、库中已有准确覆盖、证据不足的推测 → 结论选「不必迭代」或「建议关注」，不要为迭代而迭代。
