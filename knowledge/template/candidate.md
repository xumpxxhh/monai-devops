---
id: KB-CANDIDATE-{SEQ}
type: candidate                      # 知识对象类型：candidate（待确认，禁止作为事实直接引用）
domain: {domain}
application: {appCode}               # 若跨应用/属于 main 范畴可留空
status: PENDING_REVIEW               # PENDING_REVIEW/MERGED/REJECTED
sourceType: ai-assisted              # 来源：ai-assisted/personal
owner: {userId}                      # 提出人，非最终确认人
createdAt: YYYY-MM-DD HH:MM:SS
sourceRef: {requirementId 或会话/PR 链接}
confidence: low                      # candidate 默认 low，经验证可提升
evidence:
  - code: {相关代码路径，若有}
  - doc: {相关文档，若有}
  - human: {口头/评审确认，若有，注明是谁}
suggestedTarget: {建议合并到的目标路径，如 applications/{appCode}/domain/product/flow-xxx.md}
tags:
  - {tag1}
anchors:
  - APPLICATION:{appCode}
---

# {候选知识标题}

## 结论

（这条候选知识说的是什么：一句话结论）

## 来源与证据

- 来源需求/会话：{sourceRef}
- 证据：{代码位置/文档/推断依据}
- 可信度说明：{为什么是 low/medium，还缺什么才能确认}

## 待确认项

- [ ] {待 owner 或相关研发确认的问题1}
- [ ] {待确认的问题2}

## review 记录

| 日期 | review 人 | 结论 | 说明 |
|------|-----------|------|------|
| YYYY-MM-DD | {reviewer} | 待定 | - |

> review 通过并具备稳定性后，按 `suggestedTarget` 合并进 `main/` 或 `applications/`，并将本文件 status 改为 `MERGED`；若被否决，改为 `REJECTED` 并说明原因，不要直接删除。
