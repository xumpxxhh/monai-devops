---
name: git-commit
description: >
  当用户要求生成 git commit message、写提交信息、帮我提交代码、分批提交、或描述改动并需要生成符合规范的 commit 时使用。
  **触发条件**：用户说"帮我写个 commit"、"生成 commit message"、"git commit"、"提交代码"、
  "分批提交"、"计划提交"、"帮我写提交信息"，或通过 git diff / git status 提供改动内容并要求生成 commit。
  **不要触发**：纯粹的 git 操作咨询（如"怎么回退 commit"）、代码审查（使用 /code-review）、
  通用写作任务、或不涉及生成 commit message 的 git 操作。
---

# Git Commit 生成

根据用户提供的代码改动（git diff、git status、文件变更描述），分析改动内容并生成符合规范的 git commit message。

## 工作流程

1. **收集改动信息**：若用户未提供足够信息，主动运行 `git status --short` 和 `git diff --stat HEAD` 获取变更文件列表。

2. **分析改动内容**：
   - 使用 `git diff <关键文件>` 仔细阅读改动，理解改了什么、为什么改
   - 识别改动涉及的功能模块和文件路径
   - 判断改动的类型（新增功能、修复、重构、测试、配置变更、文档更新等）
   - 提取改动的核心意图和影响范围

3. **追加开发日志**（有对应包改动时必做，在分批/提交之前）：
   - 按路径映射写入 `docs/dev-logs/<包>.md`（见下方「开发日志」）
   - 跨包改动：每个包各写一条，只列该包相关文件
   - 将更新后的日志文件纳入本次（或紧随的 docs）暂存区
   - 仅改文档/根配置、或只动 `api-list.md` 时跳过

4. **分批规划**（多文件时必做）：
   - 将改动按逻辑分层分组：源码 → 测试 → 上层适配 → 文档
   - 典型批次顺序：`plugin-sdk / core-engine → plugins → server → web → docs`
   - 同一批次内的文件改动意图一致、无文件重叠
   - 先列出批次计划供用户确认，再逐批提交
   - 对应包的 `docs/dev-logs/*.md` 变更跟随该包批次，或单独 `docs` 批

5. **确定 type 和 scope**：
   - 根据改动性质匹配 type（feat / fix / refactor / chore / test / docs）
   - 从文件路径推断 scope：使用 monorepo 包名（`server`、`web`、`core-engine`、`plugin-sdk`、`plugins`、`resource`、`scheduler`）
   - 跨层改动可用 `server+web` 或省略 scope

6. **撰写 subject**：
   - 用简洁中文描述改动结果，"做了什么"而非"正在做什么"
   - 长度控制 10~25 个字
   - 技术术语保留英文（如 `workflowRunId`、`SSE`、`configSchema`）
   - 不加句号、感叹号等结尾标点
   - 可用 em-dash（—）补充关键细节，如：`运行控制基础设施 — cancel/pause/resume`
   - 可用括号引用 Issue ID，如：`移除 allocationLock 伪互斥锁与死代码 (CE-007)`
   - 可用箭头（→）表达重命名，如：`同步 resource-scheduler → resource/wait-queue`

7. **撰写 body**（必须多行）：
   - 用 3~5 行描述各模块/文件的具体变更
   - 每行一个要点，说明改了什么文件、为什么
   - 不写 `Co-Authored-By` 等 trailer

8. **提交**：展示 message 供确认后执行 `git commit -m "<message>"`。

## 开发日志

提交前为涉及的包在 `docs/dev-logs/` 追加短日志（新条目在上）。完整约定见 `.cursor/rules/dev-logs.mdc`。

| 改动路径                | 日志文件                       |
| ----------------------- | ------------------------------ |
| `packages/core-engine/` | `docs/dev-logs/core-engine.md` |
| `packages/plugin-sdk/`  | `docs/dev-logs/plugin-sdk.md`  |
| `plugins/`              | `docs/dev-logs/plugins.md`     |
| `apps/server/`          | `docs/dev-logs/server.md`      |
| `apps/web/`             | `docs/dev-logs/web.md`         |

条目模板：

```markdown
## YYYY-MM-DD

- **变更**：一句话说明做了什么
- **文件**：`path/a.ts`, `path/b.ts`
```

- `api-list.md` 是接口清单，不要按 changelog 追加。
- 同日多提交合并进同一日期标题；单条保持简短。

## Commit 格式规范

所有生成的 commit message 遵循 Conventional Commits：

```
<type>(<scope>): <subject>

<body — 3~5 行描述各模块变更>
```

详细规范见 `references/commit-rules.md`，核心约束：

| 字段     | 要求                                               |
| -------- | -------------------------------------------------- |
| type     | 必填：feat / fix / refactor / chore / test / docs  |
| scope    | 建议填写，使用 monorepo 包名；无明确归属时可省略   |
| subject  | 必填，简洁中文，10~25 字，说明改动结果，无结尾标点 |
| 冒号     | 半角 `:` 后跟一个空格                              |
| body     | 必填，3~5 行描述各模块变更                         |
| 一次提交 | 只表达一个主要意图                                 |

## type 取值

| type       | 使用场景                                                       |
| ---------- | -------------------------------------------------------------- |
| `feat`     | 功能新增、接口改造、能力增强（最常用之一）                     |
| `refactor` | 重构：重命名、架构调整、代码搬迁，不改变外部行为（最常用之一） |
| `fix`      | 缺陷修复、边界条件修正                                         |
| `test`     | 仅包含测试文件的新增或修改                                     |
| `chore`    | 格式化、依赖锁同步、脚本维护等机械性变更                       |
| `docs`     | 文档更新（README、设计文档、API 文档）                         |
| `temp`     | **历史遗留**，新提交不再使用                                   |

## scope 命名

使用 monorepo 下的真实包名或目录名：

| scope         | 对应路径                                           |
| ------------- | -------------------------------------------------- |
| `server`      | `apps/server/`                                     |
| `web`         | `apps/web/`                                        |
| `core-engine` | `packages/core-engine/`                            |
| `plugin-sdk`  | `packages/plugin-sdk/`                             |
| `plugins`     | `plugins/`（test-plugin、model-call-plugin 等）    |
| `resource`    | `packages/core-engine/resource/`（子模块级 scope） |
| `scheduler`   | `packages/core-engine/scheduler/`                  |
| `executor`    | `packages/core-engine/executor/`                   |

跨层时可用 `server+web`；无明确包归属时省略 scope。

## 分批原则

当改动涉及多个包时，按依赖关系自底向上分批：

1. **源码层**（core-engine / plugin-sdk 等基础设施）→
2. **适配层**（plugins 插件适配新 API）→
3. **服务层**（server 对接引擎新能力）→
4. **前端层**（web UI 与 API 适配）→
5. **文档层**（docs + README 同步）

每批文件无重叠、意图单一、可独立回滚。测试跟随对应源码批次或紧邻其后独立提交。

## 推荐示例

- `feat(plugin-sdk): 引入 configSchema 与 Zod 校验机制`
- `refactor(core-engine): workflowRunId 提升为显式参数`
- `feat(server): 新增插件 config JSON Schema API`
- `refactor(web): 编辑器与插件页接入 JSON Schema 动态表单`
- `test(core-engine): 运行控制与调度器取消测试`
- `fix(resource): 移除 allocationLock 伪互斥锁与死代码 (CE-007)`
- `docs: core-engine 已知问题归档与 README 重写`
- `chore: 代码格式化修正与依赖锁同步`

## 注意事项

- 生成前必须查看改动内容（`git diff`），不要凭空猜测。
- 有对应包源码改动时，**先写开发日志再提交**（见上方「开发日志」）。
- 若改动涉及多个不相关意图，拆分为多个 commit 分别提交。
- 历史笔误纠偏：`ath` → `auth`、`doce` → `docs`、全角 `：` → 半角 `:`。
- 如用户已有 `git add` 暂存的内容，优先分析暂存区（`--staged`）。
- 若用户要求直接提交，执行 `git commit -m "<message>"`，提交前展示 message 供确认。
- body 中不写 `Co-Authored-By` 等 Git trailer。
