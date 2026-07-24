# 工作流可组合化 · Agent 接手文档

> 分支：`feat/workflow-composable-unit`  
> 主计划：[`docs/plans/workflow-composable/design.md`](./design.md)  
> 状态：**已收尾**（2026-07-24）

---

## 1. 当前进度（相对 §13 分阶段）

| 阶段 | 状态 | 说明 |
|------|------|------|
| **阶段 1 · core-engine 内核** | **已完成** | 判别联合、`set_state`、`workflow` 单次+loop、`stateSchema→Zod`、`$ref` 内置 kind、`validateDag` 导出、内置步骤清单 |
| **阶段 2 · 循环与嵌套治理** | **已完成** | `validateWorkflowNesting`、`RunHandle` 级联、循环嵌循环拦截、嵌套深度 |
| **阶段 3 · 可观测性** | **已完成** | 事件 `parent`、`WORKFLOW_ITERATION_*` |
| **阶段 4 · server** | **已完成** | Prisma / imports / step-kinds / children / resolveWorkflow 查库 / EmbeddedRunHooks / initialState / 删除预检 |
| **阶段 5 · web** | **已完成** | 编辑器多 kind / 导入+二级表格 / stateSchema 双入口 / dag 复用 / 运行详情 parent+迭代 |
| **修订 · 子 run 并入父** | **已完成** | 子执行不落独立 `runs`；事件路由到顶层父 run；web 去掉 children 跳转，抽屉展示 `nestedLogs` |
| **收尾 · 文档与透传** | **已完成** | `scheduleWorkflow` 透传 `callOptions`；core-engine / server / web README + `api-list.md` |

设计与实现代码均**尚未 commit**——用户明确要求后再分批提交。

**注意**：本地若跑着 `nest start --watch`，改 Prisma schema 后需先停进程再 `pnpm --filter server db:generate`，否则 Windows 上易 EPERM 锁 `query_engine`。迁移：`pnpm --filter server db:migrate`（或等价 apply `20260724100000_workflow_composable`）。

---

## 2. 实现约定（不要破坏）

1. **导入顺序**：先 `POST /workflows` 建父 → `POST .../imports` → 再 `PUT` 写入 `kind:'workflow'` 步骤（create 时 `knownImportIds` 为空，带 workflow 步骤会 400）。
2. **copy 私有名**：`${sourceName}__copy__${uuid前8}`，保证 `name` unique。
3. **resolveWorkflow** 按 `importId` 两跳查库，不区分 reference/copy。
4. **前端**：属性面板禁止裸填 `workflowId`；无 `stateSchema` 时拦截保存含 `set_state` 的草稿。
5. **子执行不落表**：不要再恢复 `source: 'embedded'` 建行；嵌套可观测性走父事件流。
6. **`scheduleWorkflow` / `runWorkflow`**：均接受并透传 `ExecuteWorkflowCallOptions`。

---

## 3. 可选后续（非阻塞）

- [ ] until 跨轮累加场景单测加强
- [ ] imports 独立集成测（嵌套事件路由已有 `run-manager.nested-events.spec.ts`）
- [ ] web e2e 覆盖导入/嵌套 run（单测已覆盖 dag / run-state）

---

## 4. 快速上手命令

```bash
git checkout feat/workflow-composable-unit
pnpm --filter @monai-devops/core-engine build
pnpm --filter server db:generate
pnpm --filter server db:migrate
# 读设计 §0 / §8 / §9 / §10.4 / §13
```

提交建议（用户明确要求后再做）：

1. `docs: 归档工作流可组合化设计与接手文档`
2. `feat(core-engine): 支持 set_state / workflow 引用与嵌套治理 / 可观测性`（可再拆）
3. `feat(server): 工作流导入、嵌套校验；子执行事件并入父 run`
4. `feat(web): 可组合工作流编辑器与运行详情嵌套聚合`

提交前写/合并 `docs/dev-logs/core-engine.md`、`docs/dev-logs/server.md`、`docs/dev-logs/web.md`。
