# AI 智能体执行编排与执行引擎演进推演（待评审）

> **文档状态：待评审（Draft）**
>
> **重要声明：本文是一条独立于 CI/CD 的并行推演路线，不是 CI/CD 路线的子阶段，也不是已确定的产品路线或技术方案。**
> 本文仅讨论如何基于现有通用工作流内核，演进出面向 AI Agent 的执行编排与执行引擎。

- 归档日期：2026-09-18
- 当前状态：待评审
- 决策状态：未决策
- 路线关系：与 CI/CD 路线并行、相互解耦
- 适用范围：Agent Runtime、工具调用、智能任务编排和人机协同的方向讨论

**关联文档**

- 项目总览：[README.md](../../../README.md)
- 编排内核：[packages/core-engine/README.md](../../../packages/core-engine/README.md)
- 插件 SDK：[packages/plugin-sdk/README.md](../../../packages/plugin-sdk/README.md)
- 工作流可组合化设计：[workflow-composable/design.md](../workflow-composable/design.md)
- CI/CD 独立推演：[enterprise-ci-cd-roadmap-draft.md](../ci-cd-engine/enterprise-ci-cd-roadmap-draft.md)

---

## 1. 路线边界

本路线讨论的是通用 AI Agent 执行平台，例如：

- 研究与分析 Agent；
- 文档生成与审阅 Agent；
- 数据处理与知识维护 Agent；
- 客服、运营和内部流程 Agent；
- 多 Agent 协作任务；
- 需要模型规划、工具调用和人工确认的长期任务。

本路线不讨论：

- 代码构建、测试、部署和发布流水线；
- Git Runner、制品库、部署环境和 CI/CD 触发器；
- 将 Agent 作为 CI/CD 平台的附属功能；
- 具体模型厂商、向量数据库或消息中间件的最终选型。

核心假设是：Agent 是一种**受策略、预算、工具权限和生命周期控制的动态工作流执行单元**。

---

## 2. 初步可行性判断

当前项目可以作为 Agent 执行编排的底层基础，但不能直接把现有插件步骤改名为 Agent。

适合保留的通用能力包括：

- DAG 和依赖调度；
- 工作流嵌套与循环；
- Run 状态、暂停、恢复和取消；
- 资源槽位与并发限制；
- Context 引用与状态传递；
- 生命周期事件和实时观测；
- 插件契约和结构化输入输出。

需要新增的是一层独立的 Agent Runtime，负责模型规划、工具选择、观察结果、短期记忆、预算控制和人工审批。

建议的分层关系：

```text
Agent Workflow
    │
    ├── Agent Step
    │      ├── Model Adapter
    │      ├── Tool Registry
    │      ├── Agent State
    │      ├── Policy / Approval
    │      └── Iteration Controller
    │
    └── Existing Workflow Steps
           ├── plugin
           ├── workflow
           └── set_state
```

---

## 3. 核心执行模型

### 3.1 Agent Step

可以新增一种由引擎原生理解的步骤形态：

```ts
{
  kind: 'agent',
  id: 'investigate',
  agent: 'research-agent',
  goal: '整理指定主题的事实、争议和待验证问题',
  tools: ['search', 'read_document', 'write_note'],
  maxIterations: 20,
  timeoutMs: 600000,
  budget: {
    maxTokens: 50000,
    maxCost: 2
  },
  approvalPolicy: 'required-for-write'
}
```

对外，Agent Step 仍然是普通 Workflow Step；对内，它运行动态决策循环：

```text
读取目标与上下文
    ↓
模型规划下一步
    ↓
选择工具
    ↓
执行工具并取得 observation
    ↓
更新 Agent State
    ↓
继续、暂停、请求批准或结束
```

第一阶段建议只允许 Agent 从预先登记的工具集合中选择，不允许模型任意修改外部 Workflow DAG。

### 3.2 Agent 与普通 Workflow 的关系

建议采用“确定性工作流包裹动态 Agent”的模型：

- Workflow 负责边界、依赖、资源和终态；
- Agent 负责目标分解、工具选择和局部决策；
- Tool 负责具体副作用；
- Policy 负责判断 Agent 能做什么；
- Human Approval 负责高风险动作的最终确认。

这样既能支持动态行为，也能保留可审计、可取消和可恢复的执行边界。

---

## 4. Agent Runtime 需要新增的能力

### 4.1 模型适配

需要统一封装：

- 非流式和流式模型调用；
- Tool Calling；
- 多模型供应商；
- 超时、重试和 fallback；
- Prompt 与 Policy 版本；
- Token、费用、延迟和错误统计；
- 模型输出结构校验。

现有模型插件可以作为原型适配器，但生产级能力应沉淀为稳定的 Model Adapter 协议。

### 4.2 Tool Registry

工具不能只被当作普通插件暴露，还需要声明：

- 工具名称、版本和输入输出 schema；
- 是否有外部副作用；
- 需要哪些 capability；
- 可访问的资源范围；
- 是否必须人工审批；
- 超时、重试和幂等语义；
- 工具调用的审计字段。

现有插件可以逐步包装为工具，但工具权限不能仅由模型 Prompt 约束。

### 4.3 Agent State 与记忆

需要区分不同类型的状态：

| 状态类型 | 作用 | 生命周期 |
| -------- | ---- | -------- |
| Run State | 当前任务的结构化状态 | 单次 Run |
| Working Memory | 当前 Agent 的中间推理和观察 | 单个 Agent Run |
| Conversation History | 模型消息与工具调用轨迹 | 可审计、可归档 |
| Long-term Memory | 跨任务复用的知识 | 跨 Run |
| Artifact State | 文档、记录和外部资源状态 | 由业务定义 |

不建议把完整对话和大对象全部写进 Run JSON；应区分结构化状态、事件轨迹和大对象存储。

### 4.4 预算与终止控制

Agent 必须受到硬边界约束：

- 最大迭代次数；
- 最大 Token 数；
- 最大费用；
- 最大执行时间；
- 工具调用次数；
- 单工具超时；
- 递归 Agent 深度；
- 最大上下文长度。

任何预算耗尽都应产生明确的终态和原因，而不是依赖模型自行停止。

### 4.5 人机协同

需要支持：

- Agent 请求人工输入；
- 高风险工具调用审批；
- 暂停后恢复；
- 人工修改目标或上下文；
- 人工接管并结束 Agent；
- 记录批准人、批准内容和批准时上下文。

现有 Run pause/resume 能力可以作为底层基础，但需要增加等待输入和审批状态。

### 4.6 Agent Trace

除普通步骤事件外，需要记录完整的 Agent 轨迹：

```text
run started
model request
model response
tool call
tool result
state update
approval requested
approval granted
agent finished
```

每个事件至少应包含 Run、Agent、迭代、模型版本、工具版本和因果关联信息。

---

## 5. 安全与治理边界

Agent 的风险不只来自代码执行，也来自模型自主调用外部系统。因此至少需要：

- Tool 白名单和 capability 模型；
- 参数和输出 schema 校验；
- 访问范围、租户和身份绑定；
- Secret 的按需、短期注入；
- 网络、文件和外部系统访问策略；
- 高风险工具强制审批；
- Prompt、Tool、Model 和 Policy 版本锁定；
- 完整工具调用审计；
- 输出内容的敏感信息检测；
- Agent 之间的权限隔离。

安全策略不能只写在 Prompt 中，必须由 Runtime 和 Tool Gateway 强制执行。

---

## 6. 候选模块边界

如果方向获得认可，可以评估新增以下模块：

| 候选模块 | 候选职责 | 状态 |
| -------- | -------- | ---- |
| `packages/agent-runtime` | Agent 循环、状态机、预算、工具调用和终止控制 | 待评审 |
| `packages/agent-protocol` | Model、Tool、Observation、Approval、Trace 数据结构 | 待评审 |
| `packages/model-adapters` | 多模型供应商和统一调用协议 | 待评审 |
| `packages/tool-registry` | 工具注册、schema、capability 和版本治理 | 待评审 |
| `apps/agent-control` | Agent 配置、审批、运行观测和管理 API | 待评审 |

现有模块的候选定位：

- `packages/core-engine`：通用工作流状态机和确定性调度；
- `packages/plugin-sdk`：低层能力实现和结构化契约；
- `plugins/*`：经过权限声明的 Tool 实现；
- `apps/server`：可继续承载通用 Run、工作流和持久化能力；
- 前端：增加 Agent 配置、轨迹、审批和人工接管界面。

以上名称和职责是占位设计，不代表已批准的代码结构。

---

## 7. 候选演进阶段

> 以下阶段用于表达依赖和验证顺序，不代表已批准的排期。

### 阶段 A：受控 Agent Step 验证

目标：验证模型选择工具的最小闭环。

候选内容：

- 单一模型适配器；
- 固定工具集合；
- 最大迭代、超时和 Token 预算；
- 工具调用与 Agent Trace；
- 单次人工审批；
- Agent 作为现有 Workflow 中的黑盒步骤。

退出条件：能够稳定完成有限目标，并在超时、取消、预算耗尽和工具失败时产生可解释终态。

### 阶段 B：可恢复的 Agent Runtime

目标：支持生产前的长任务和异常恢复。

候选内容：

- Agent State 持久化；
- 暂停、恢复和等待人工输入；
- Tool Registry 与 capability；
- 模型重试和 fallback；
- 消息轨迹归档；
- 失败后从最近 checkpoint 恢复；
- 费用和并发配额。

退出条件：服务重启、模型超时、工具失败和人工延迟不会造成状态丢失或重复副作用。

### 阶段 C：受治理的多 Agent 编排

目标：支持多个 Agent 在统一任务中协作。

候选内容：

- Supervisor Agent；
- Agent delegation；
- 并行 Agent 和共享任务状态；
- Agent 间消息协议；
- 子 Agent 权限、预算和递归深度限制；
- 冲突检测和汇总策略；
- 人工接管和仲裁。

### 阶段 D：长期运行的自主任务

目标：支持监控、周期任务和事件驱动的长期 Agent。

候选内容：

- 外部事件触发；
- 长期记忆和知识更新；
- 周期性唤醒；
- 任务租约和断点恢复；
- 预算周期与自动熔断；
- 策略变更和模型升级的兼容治理。

---

## 8. 主要风险

| 风险 | 说明 | 建议验证方式 |
| ---- | ---- | ------------ |
| 动态行为不可预测 | 模型可能选择错误工具或陷入循环 | 工具白名单、预算和轨迹回放 |
| 状态膨胀 | 对话、观察和长期记忆难以全部放入 Run | 分离 State、Trace 和 Memory 存储 |
| 副作用重复 | 模型重试可能重复发送消息或修改外部数据 | 工具幂等键、审批和 checkpoint |
| 成本失控 | Token、工具和长任务成本不可预期 | 硬预算、配额和熔断 |
| 权限越界 | Prompt 无法替代真实权限控制 | capability、Tool Gateway 和审计 |
| 结果难解释 | 只有最终答案而没有决策轨迹 | 统一 Agent Trace 与重放能力 |
| 多 Agent 复杂度 | 委派、共享状态和冲突会放大一致性问题 | 先做单 Agent，再做受限协作 |
| 模型升级漂移 | 模型版本变化导致行为和结果变化 | 模型版本锁定、评测和回归集 |

---

## 9. 待评审问题

正式形成路线前，至少需要明确：

1. 首批 Agent 面向哪些业务任务和用户？
2. Agent 需要操作哪些外部系统？
3. 哪些工具属于只读、可写和高风险操作？
4. 是否允许 Agent 动态创建子任务或子工作流？
5. 是否允许多 Agent 协作，还是先限定为单 Agent？
6. 需要支持哪些模型协议和供应商？
7. Run State、Conversation Trace 和 Long-term Memory 的边界是什么？
8. 预算按用户、项目、Agent 还是组织分配？
9. 哪些场景必须人工批准？
10. Agent 失败后允许自动重试到什么程度？
11. 是否需要完整的执行轨迹回放和离线评测？
12. 多租户、敏感数据和合规要求是什么？

---

## 10. 建议的下一步评审产物

如果决定继续验证，建议先产出：

1. Agent Runtime 最小状态机；
2. Model Adapter 与 Tool Registry RFC；
3. Tool capability 和审批策略；
4. Agent Trace 事件模型；
5. 单 Agent 受控执行 PoC；
6. 预算、重试和幂等语义说明；
7. 单 Agent 评测集与成功标准；
8. 安全威胁模型和数据流图。

评审通过后，应将已确认内容单独沉淀为 ADR/RFC；未确认内容继续保留为假设，不应直接作为实现依据。
