# monai-devops

插件化工作流编排平台：用可视化 DAG 编排步骤、按资源槽位调度执行，并通过 HTTP / WebSocket 实时观察运行过程。

业务能力以独立插件包实现；编排内核与插件契约分离；NestJS 服务负责持久化与 API；React 控制台负责设计与运维。

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│  apps/web              控制台：编辑器 / 运行详情 / 插件试运行 │
└───────────────────────────┬─────────────────────────────────┘
                            │ REST · SSE · WebSocket
┌───────────────────────────▼─────────────────────────────────┐
│  apps/server           NestJS：工作流 / Run / 插件 / 资源 API │
│                        Prisma + PostgreSQL                   │
└───────────────────────────┬─────────────────────────────────┘
                            │ createEngine
┌───────────────────────────▼─────────────────────────────────┐
│  packages/core-engine  DAG 调度 · 资源池 · Run 控制 · 事件   │
└───────────────────────────▼─────────────────────────────────┐
│  packages/plugin-sdk   createPlugin · config/result schema · 取消 │
└───────────────────────────▼─────────────────────────────────┐
│  plugins/*             业务插件（只依赖 plugin-sdk）          │
└─────────────────────────────────────────────────────────────┘
```

**依赖方向（勿逆向）：**

| 包            | 可依赖                                       |
| ------------- | -------------------------------------------- |
| `plugins/*`   | `plugin-sdk`（及自身业务依赖）               |
| `core-engine` | `plugin-sdk`                                 |
| `apps/server` | `core-engine` + 已注册插件                   |
| `apps/web`    | `core-engine`（类型与纯函数；执行走 server） |

## 仓库结构

```
monai-devops/
├── apps/
│   ├── server/          # NestJS API + WebSocket + Prisma
│   └── web/             # React + Vite 控制台
├── packages/
│   ├── core-engine/     # 工作流编排内核
│   └── plugin-sdk/      # 插件契约与辅助工具
├── plugins/             # 工作区插件包
├── docs/                # 设计稿、计划、开发日志、接口清单
├── scripts/             # create-plugin / sync-plugin-registry
├── docker/postgres/     # 公共 Postgres 建库脚本
└── docs/ops/            # 运维说明（含 postgres-shared.md）
```

### 包文档

| 路径                                                               | 说明                                             |
| ------------------------------------------------------------------ | ------------------------------------------------ |
| [apps/server/README.md](./apps/server/README.md)                   | 后端启动、环境变量、API / WS、数据模型           |
| [apps/web/README.md](./apps/web/README.md)                         | 前端路由、编辑器、实时订阅、环境变量             |
| [packages/core-engine/README.md](./packages/core-engine/README.md) | 引擎：步骤形态、DAG、资源、取消/暂停、嵌套工作流 |
| [packages/plugin-sdk/README.md](./packages/plugin-sdk/README.md)   | 插件契约、`createPlugin`、协作取消、日志         |
| [plugins/README.md](./plugins/README.md)                           | 插件开发指南（脚手架、注册、调试）               |
| [docs/dev-logs/api-list.md](./docs/dev-logs/api-list.md)           | 服务端接口清单（非 changelog）                   |

### 当前内置插件

由 `apps/server/plugins.config.json` 启用，构建前经 `pnpm sync:plugins` 写入注册表：

| 包名                 | 用途                             |
| -------------------- | -------------------------------- |
| `test-plugin`        | 可中断的示例测试步骤             |
| `print-plugin`       | 打印 / 日志输出                  |
| `muti-result-plugin` | 多层嵌套结果（便于 `$ref` 演示） |
| `model-call-plugin`  | 大模型调用                       |
| `embedding-plugin`   | Embedding 调用                   |
| `git-checkout-plugin` | 克隆仓库到 Run 工作区（CI PoC） |
| `shell-exec-plugin` | 在工作区内执行 shell 命令（CI PoC） |
| `file-inject-plugin` | 按相对路径写入文件（CI PoC）     |

部分插件依赖外部环境变量（如 `OPENAI_API_KEY`、`EMBEDDING_API_KEY`）；Turbo 已配置透传。

---

## 环境要求

- **Node.js** `>= 20`
- **pnpm** `10.18.2`（见 `packageManager`）
- **团队公共 PostgreSQL**（库 `monai_devops` / `monai_devops_test`，见 [docs/ops/postgres-shared.md](./docs/ops/postgres-shared.md)）

---

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 准备数据库

团队**共享**公共 Postgres，库名固定为 `monai_devops`（开发）与 `monai_devops_test`（测试）。

1. 在公共实例上建库（若尚未创建）：见 [docs/ops/postgres-shared.md](./docs/ops/postgres-shared.md)
2. 从本项目旧 compose 迁数据（若需要）：同上文档「从本项目旧 compose 卷迁移数据」
3. 在 `apps/server` 配置 `DATABASE_URL`（`.env.example` / `.env.test`；host 按公共实例修改）

### 3. 配置并迁移服务端

```bash
cd apps/server
cp .env.example .env
# 建议把 GLOBAL_API_PREFIX 改成与前端一致：api/v1/devops
# 或直接用测试环境启动（见下）

pnpm db:generate
pnpm db:migrate:dev
```

前端开发默认请求 `http://localhost:3000/api/v1/devops`（见 `apps/web/.env.development`）。  
服务端 `.env.example` 模板前缀为 `api`，**联调前请对齐前缀**。推荐两种方式之一：

- 改 `apps/server/.env`：`GLOBAL_API_PREFIX=api/v1/devops`
- 或服务端用测试 env：`pnpm --filter server db:migrate:test` 后 `pnpm dev:server:test`（读 `.env.test`，前缀已是 `api/v1/devops`）

### 4. 启动开发进程

```bash
# 仓库根：分别启动
pnpm dev:server          # 或 pnpm dev:server:test（对齐 web 默认 API 前缀）
pnpm dev:web

# 也可一次拉起 workspace 内所有 dev（会先 ^build）
pnpm dev
```

- Web：Vite，默认 `http://127.0.0.1:5173`
- Server：默认 `http://localhost:3000/{GLOBAL_API_PREFIX}`
- 健康检查：`GET /{prefix}/healthz`

### 5. 打开控制台

浏览器访问 Web 地址 → 侧栏进入「工作流」新建 DAG，或在「插件」页试运行。

---

## 常用脚本（仓库根）

| 脚本                                | 作用                                                 |
| ----------------------------------- | ---------------------------------------------------- |
| `pnpm build`                        | Turbo 构建全部包                                     |
| `pnpm dev`                          | 全部包 `dev`（依赖上游先 build）                     |
| `pnpm dev:server` / `dev:web`       | 仅后端 / 仅前端                                      |
| `pnpm dev:server:test` / `dev:test` | 使用各包 `dev:test`（server 强制 `.env.test`）       |
| `pnpm test`                         | 全仓测试（会先 `^build`）                            |
| `pnpm lint` / `lint:fix`            | ESLint                                               |
| `pnpm format` / `format:check`      | Prettier                                             |
| `pnpm check-types`                  | 类型检查                                             |
| `pnpm create:plugin <name>`         | 脚手架新建插件并写入配置                             |
| `pnpm sync:plugins`                 | 根据 `plugins.config.json` 生成 `plugin-registry.ts` |

包内还有各自的 `db:migrate*`、`test:e2e` 等，见对应 README。

---

## 核心能力一览

| 能力             | 说明                                                                 |
| ---------------- | -------------------------------------------------------------------- |
| **DAG 工作流**   | `dependsOn` 拓扑并行；条件跳过；failFast                             |
| **步骤形态**     | `plugin`（默认）、`set_state`、`workflow`（引用子工作流，可选 loop） |
| **Context 引用** | 配置中 `$ref` 引用上游 `data` 或 run `state`                         |
| **资源调度**     | 按 `resourceType` 抢槽；步骤级等待队列 + workflow 级任务调度器       |
| **Run 控制**     | cancel（best-effort / hard）、pause / resume；嵌套级联               |
| **可观测性**     | 生命周期事件落库 + WS 推流；插件日志 SSE/WS                          |
| **可组合工作流** | 导入 `reference` / `copy`；嵌套深度与「循环嵌循环」约束              |

---

## 开发约定（摘要）

- **插件失败用 `PluginResult`，不要靠 throw 表达业务失败**；取消用 `AbortSignal` + `PluginCancelledError`。
- **新增插件**：`pnpm create:plugin` → 实现 → `pnpm sync:plugins` → 重启 server。详情见 [plugins/README.md](./plugins/README.md)。
- **提交前**：仓库使用 husky + lint-staged；涉及包改动时按 `.cursor/rules/dev-logs.mdc` 追加 `docs/dev-logs/*.md`（提交代码时）。
- **接口清单**：`docs/dev-logs/api-list.md` 是 API 目录，不是 changelog。
- **无内建认证**：当前 HTTP/WS 开放，生产需自行加网关或守卫。

---

## 文档与计划

| 目录              | 内容                                         |
| ----------------- | -------------------------------------------- |
| `docs/dev-logs/`  | 各包开发日志 + `api-list.md`                 |
| `docs/plans/`     | 引擎 / server / web / 可组合工作流等设计计划 |
| `docs/design/`    | 控制台等设计说明                             |
| `docs/prototype/` | HTML 原型（如有）                            |
| `.claude/skills/` | 提交规范、原型等 Agent skill                 |

---

## 技术栈摘要

| 层       | 技术                                                                   |
| -------- | ---------------------------------------------------------------------- |
| Monorepo | pnpm workspace + Turbo                                                 |
| 内核     | TypeScript ESM、Zod（经 plugin-sdk）                                   |
| 后端     | NestJS 11、Prisma 6、PostgreSQL、`ws`                                  |
| 前端     | React 19、Vite 8、React Flow、Tailwind、Radix                          |
| 质量     | ESLint、Prettier、Jest（server）、Vitest（web）、Node test（packages） |

---

## License

根 `package.json` 为 private monorepo。各可发布包（如 `core-engine` / `plugin-sdk`）见各自 `package.json` 的 `license` 字段。
