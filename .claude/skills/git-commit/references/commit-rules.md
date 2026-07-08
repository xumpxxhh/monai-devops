# Git Commit 规则详细说明

基于 monorepo 项目提交历史总结的 commit message 规范。

## 格式结构

多行 commit 是标准格式：

```
<type>(<scope>): <subject>

<body — 3~5 行描述各模块变更>
```

## 格式约束

- `type` 必填，小写英文
- `scope` 建议填写，使用 monorepo 包名或目录名
- `subject` 必填，简洁中文（10~25 字）
- 冒号后保留一个空格
- body 必填，3~5 行描述各模块/文件的具体变更
- 一次提交只表达一个主要意图
- 新提交统一使用半角标点：`type(scope): subject`（不要用全角 `：`）
- body 中不写 `Co-Authored-By` 等 Git trailer

## type 取值

| type | 说明 |
|------|------|
| `feat` | 功能新增、接口改造、能力增强（最常用） |
| `refactor` | 重构：重命名、架构调整、代码搬迁，不改变外部行为（最常用） |
| `fix` | 缺陷修复、边界条件修正 |
| `test` | 仅包含测试文件的新增或修改 |
| `chore` | 格式化、依赖锁同步、脚本维护等机械性变更 |
| `docs` | 文档更新（README、设计文档、API 文档） |
| `temp` | **历史遗留，新提交禁用**。合并前应被 squash 或删除 |

### type 选择优先级

1. 纯测试文件 → `test`
2. 纯文档文件 → `docs`
3. 修复 Bug → `fix`
4. 重构/重命名/搬迁（无行为变化）→ `refactor`
5. 新增能力 → `feat`
6. 格式化/依赖锁 → `chore`

## scope 命名

使用 monorepo 下的真实包名，与目录结构一致：

| scope | 对应路径 | 使用场景 |
|-------|---------|---------|
| `server` | `apps/server/` | 服务端逻辑、REST API、WebSocket |
| `web` | `apps/web/` | 前端页面、组件、API 客户端 |
| `core-engine` | `packages/core-engine/` | 引擎核心（executor、engine、scheduler 等） |
| `plugin-sdk` | `packages/plugin-sdk/` | 插件 SDK（createPlugin、logger 等） |
| `plugins` | `plugins/` | test-plugin / model-call-plugin 等插件包 |
| `resource` | `packages/core-engine/resource/` | 子模块级精确 scope |
| `scheduler` | `packages/core-engine/scheduler/` | 子模块级精确 scope |

同一 commit 跨多层时：
- 两层的可用 `server+web`、`core-engine+plugins` 等组合
- 三层及以上或无明显主层时可省略 scope

## subject 编写规范

- 说明"做了什么"，不写"在做什么"
- 避免空泛描述，如"调整一下""更新代码"
- 不包含句号、感叹号等结尾标点
- 控制长度 10~25 个字
- 优先使用中文；技术术语可保留英文

### 常用 subject 模式

| 模式 | 示例 |
|------|------|
| 主描述 + em-dash 补充 | `运行控制基础设施 — cancel/pause/resume` |
| 括号引用 Issue ID | `移除 allocationLock 伪互斥锁 (CE-007)` |
| 箭头表达重命名 | `同步 resource-scheduler → resource/wait-queue` |
| 英文术语自然嵌入 | `适配新事件结构 workflowRunId 顶层字段` |
| 并列对象 | `test-plugin 与 model-call-plugin 适配 configSchema` |

## body 编写规范

body 是必填部分，用 3~5 行中文描述各模块/文件的具体变更：

- 按模块分组：先源码、后适配、最后文档
- 每行一个要点，说明"改了什么 + 为什么"
- 技术细节保留英文（函数名、类型名、文件路径）
- 不写 `Co-Authored-By` 等 Git trailer

### body 示例

```
新增 RunHandle（单 Run 控制态：cancel/pause/resume/destroy +
AbortSignal 注入步骤）、RunRegistry（活跃注册表 + 防重入）。
引擎新增 cancelRun/pauseRun/resumeRun/getRunStatus API，
支持 best-effort/hard 两种取消模式，hard cancel 带超时。
事件新增 workflow:cancelled/paused/resumed 三种类型。
调度器新增 cancelScheduledTask + cancelScheduledTaskByWorkflowRunId。
```

## 分批提交原则

改动跨越多个包时，按依赖方向自底向上分批：

```
plugin-sdk / core-engine  →  plugins 适配  →  server 对接  →  web UI  →  docs
```

每批规则：
- 文件无重叠，意图单一
- 每批均可独立 `git revert` 而不破坏其他批次
- 测试与源码可同批（`refactor: xxx` + test 同行改动）或紧邻独立提交（`test: xxx`）
- 文档始终在最后批次
- `pnpm-lock.yaml` 放最后或合入对应依赖变更批次

### 分批示例

```
批次 1: refactor(core-engine): workflowRunId 提升为显式参数
批次 2: refactor(server): 适配 core-engine workflowRunId 新 API
批次 3: refactor(web): 适配新事件结构 workflowRunId 顶层字段
```

## subject 质量示例

### 好的 subject

- `引入 configSchema 与 Zod 校验机制`
- `workflowRunId 提升为显式参数`
- `编辑器与插件页接入 JSON Schema 动态表单`
- `补充缺陷修复对应的测试用例`
- `修复密码重置邮件偶发收不到的问题`

### 不好的 subject

| 示例 | 问题 |
|------|------|
| `调整一下` | 空泛，未说明具体调整了什么 |
| `更新代码` | 过于宽泛，无具体信息 |
| `修复了一个bug。` | 结尾有多余标点，且未说明修了什么 |
| `在优化登录流程` | "在"字多余，应直接说"优化登录流程" |
| `改了改样式` | 口语化，不专业 |
| `runWorkflow 添加参数并修改事件结构和 resource scheduler` | 过长且混杂多个意图，应拆分 |

## 历史兼容与纠偏

- 历史中出现过 `doce`，后续统一改用 `docs`
- 历史中出现过全角冒号 `：`，后续统一改用半角冒号 `:`
- 历史中出现过 `ath`（应为 `auth`），后续统一更正
- 历史 `temp` type 不再使用
- 提交前自检一次 `type` 拼写
