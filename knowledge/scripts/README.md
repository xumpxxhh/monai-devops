# knowledge/scripts — 维护检查脚本

辅助体检信号；**主维护路径是显式 kb-iterate**（assess → 确认 → apply）。

## 脚本

| 脚本 | 作用 |
|------|------|
| `check-candidate-sla.mjs` | candidate 待 review 超过 14 天（可调） |
| `check-routing-coverage.mjs` | 知识 `anchors` 未出现在 ROUTING.md |
| `check-knowledge-freshness.mjs` | OFFICIAL 的 `lastVerifiedAt` 超过 90 天（可调） |
| `lib-frontmatter.mjs` | 上述脚本共用 |

## 命令（仓库根）

```bash
node knowledge/scripts/check-candidate-sla.mjs --dir knowledge/candidate --days 14
node knowledge/scripts/check-routing-coverage.mjs --knowledge-dir knowledge --routing-file knowledge/ROUTING.md
node knowledge/scripts/check-knowledge-freshness.mjs --dir knowledge --days 90
```

阈值见 [KNOWLEDGE-RULES.md](../KNOWLEDGE-RULES.md)。未接 CI 时本地按需运行即可。
