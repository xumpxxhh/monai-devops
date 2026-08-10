# monai-devops 知识库

本目录沉淀**稳定业务语境与架构边界**，供人与 AI 在改代码前先「路由定位、渐进读取」。**接口签名、字段、枚举、开关等易变事实以当前仓库代码与 `docs/dev-logs/api-list.md` 为准**；知识库只提供入口，不替代实现。

## 怎么用

1. 判断本次改动是否涉及业务语义、跨模块边界、状态/契约/兼容 → 是则读 [ROUTING.md](./ROUTING.md) 定位应用与文件。
2. 按应用 [INDEX.md](./applications/server/INDEX.md) 等说明的路径阅读：`应用总览 → product 主干 → base 索引 → tech 规范 → 回代码核对`。
3. 样式、文案、单测微调、依赖锁、同文件纯重构等可**跳过 KB**，直接改代码。
4. 未经验证的结论只进 [candidate/](./candidate/README.md) 或 [personal/](./personal/README.md)，不得当正式事实引用。

## 目录结构（轻量模式）

| 目录 | 用途 |
|------|------|
| [main/](./main/README.md) | 跨应用公共语境 |
| [applications/](./INDEX.md#按应用) | 按模块拆分的正式知识 |
| [candidate/](./candidate/README.md) | 待 review 的候选知识 |
| [personal/](./personal/README.md) | 个人经验草稿 |
| [template/](./template/application.md) | 强约束文档模板 |
| [scripts/](./scripts/README.md) | KB 维护检查脚本（可选） |

**KB 相关正文、模板、治理与 scripts 均在本 `knowledge/` 树下**，不放在仓库根 `scripts/`。

## 已有文档（保留原位置）

设计稿、计划、开发日志等仍在仓库 `docs/` 与各包 `README.md`；入口见 [INDEX.md](./INDEX.md#仓库内已有文档索引)。

## AI 接入

- **读库**：`.cursor/rules/knowledge-base.mdc`（先判断可跳过，再 ROUTING）；按需使用 Skill `kb-usage`（lookup / backfill）。
- **维护主路径**：显式触发 `kb-iterate` → assess（只读）→ 人工确认 → apply（**默认只写** `candidate/`）。升 official 或改 ROUTING 须另审。

触发示例：「KB 迭代评估」「kb assess」「按提案写入 candidate」。

## 辅助体检（脚本）

维护以 **AI 迭代**为主；以下为可选信号（仓库根执行）：

```bash
node knowledge/scripts/check-candidate-sla.mjs --dir knowledge/candidate --days 14
node knowledge/scripts/check-routing-coverage.mjs --knowledge-dir knowledge --routing-file knowledge/ROUTING.md
node knowledge/scripts/check-knowledge-freshness.mjs --dir knowledge --days 90
```

加 `--strict` 可在 CI 中作提醒或门禁（本项目默认未接 CI）。

## 治理

- 状态机与证据要求：[KNOWLEDGE-RULES.md](./KNOWLEDGE-RULES.md)
- 线索路由：[ROUTING.md](./ROUTING.md)
