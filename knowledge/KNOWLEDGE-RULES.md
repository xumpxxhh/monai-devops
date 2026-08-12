# 知识治理规则

## 1. 状态机（status）

```
DRAFT -> CANDIDATE -> OFFICIAL -> DEPRECATED
```

| 状态 | 含义 | 能否作为事实引用 |
|------|------|------------------|
| `DRAFT` | 初稿，尚未验证 | 不能，仅供起草参考 |
| `CANDIDATE` | 有来源和证据，等待 owner/研发确认 | 不能，需标注「待确认」 |
| `OFFICIAL` | 已被确认，具备一定稳定性 | 可以，但易变字段仍需回代码核对 |
| `DEPRECATED` | 已过期或已被替代 | 不能，应指向替代文档 |

晋级：`personal/` 可随时写；进 `candidate/` 须标来源/证据/可信度/待确认项；进 `OFFICIAL` 须至少一类证据且经相关研发确认，并具备一定稳定性。

降级：业务或代码变化后标 `DEPRECATED` 并指向替代文档，不直接删历史文件。

## 2. 可信度（confidence）

| 值 | 含义 |
|---|---|
| `high` | 代码 + 人工双重确认 |
| `medium` | 有证据但未完全验证 |
| `low` | 以推断为主，主要用于 candidate/personal |

## 3. 稳定性（stability）

| 值 | 含义 |
|---|---|
| `stable` | 架构约束、核心流程主干 |
| `evolving` | 多数 flow/rule |
| `volatile` | 接口签名、枚举、开关、feature key |

`volatile` 即使 `OFFICIAL` 也只作定位入口，改代码前必须回仓库核对。

## 4. 新鲜度（lastVerifiedAt）

`OFFICIAL` 知识应维护 `lastVerifiedAt`（最近一次回代码核对仍准确的时间）。建议阈值：**90 天**未核对则复核（可用 `knowledge/scripts/check-knowledge-freshness.mjs`，复制脚本后）。

## 5. 证据（evidence）

- `code`：模块或文件路径
- `doc`：README、计划、PR
- `human`：确认人 + 时间

`OFFICIAL` 建议至少两类证据（如 `code` + `human`）。

## 6. candidate 区 SLA（建议）

- 待 review 超过 **14 天**提醒处理（合并 official / REJECTED）
- WIP 候选超过 **20** 条提醒收敛

（阈值可在复制维护脚本后写入 CI 或本地检查。）

## 7. 边界

- 小改动可直接改代码 + 轻量回补一条 `candidate`，不必套满流程。
- KB 目标是「找得对、读得少、信得过」，不追求一次写全。
