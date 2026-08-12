# 知识路由（ROUTING）

收到需求后**不要全量读 knowledge/**：先从这里根据线索定位应用与文件，再渐进加载，易变细节回代码核对。

## 按应用

| 应用名 | 应用编码 | 一句话职责 | 知识入口 | 代码路径 |
|---|---|---|---|---|
| 后端服务 | server | NestJS API/WS、Prisma、引擎接入与 Run 推流 | [INDEX.md](./applications/server/INDEX.md) | `apps/server/` |
| 控制台 | web | 工作流编辑、运行详情、插件试运行 | [INDEX.md](./applications/web/INDEX.md) | `apps/web/` |
| 编排内核 | core-engine | DAG 执行、资源槽位、取消/暂停 | [INDEX.md](./applications/core-engine/INDEX.md) | `packages/core-engine/` |
| 插件 SDK | plugin-sdk | 插件契约与 `createPlugin` | [INDEX.md](./applications/plugin-sdk/INDEX.md) | `packages/plugin-sdk/` |
| 业务插件 | plugins | 工作区插件包、注册与调试 | [INDEX.md](./applications/plugins/INDEX.md) | `plugins/` |

### 常见线索 → 入口

| 线索类型 | 示例 | 建议路径 |
|---|---|---|
| 改 HTTP/WS、Run 落库、Prisma | 「Run 取消接口」「WebSocket 事件」 | server → [domain/base/](./applications/server/domain/base/README.md) → `docs/dev-logs/api-list.md` |
| 改编辑器、画布、前端路由 | 「工作流编辑器」「JsonSchemaForm」 | web → [domain/product/](./applications/web/domain/product/README.md) |
| 改调度、DAG、资源池 | 「步骤并行」「resourceType」 | core-engine → [domain/product/](./applications/core-engine/domain/product/README.md) |
| 改插件 execute/取消/schema | 「createPlugin」「PLUGIN_CANCELLED」 | plugin-sdk → [domain/product/](./applications/plugin-sdk/domain/product/README.md) |
| 新建/注册插件包 | 「sync:plugins」「plugins.config.json」 | plugins → [plugins.md](./applications/plugins/plugins.md) + 根 [plugins/README.md](../plugins/README.md) |
| 跨层依赖方向 | 「server 能否依赖 plugin」 | [main/README.md](./main/README.md) + 根 [README.md](../README.md) 架构表 |

## 按 Topic / 消息

| Topic | 归属应用 | 知识入口 |
|---|---|---|
| （待补充） | — | 引擎/服务端事件以代码与 `api-list` 为准 |

## 按接口名

| 接口/路由 | 归属应用 | 知识入口 |
|---|---|---|
| （待补充） | server | [domain/base/README.md](./applications/server/domain/base/README.md) + [api-list.md](../docs/dev-logs/api-list.md) |

## 按状态 / Run 生命周期

| 状态/阶段 | 归属 | 知识入口 |
|---|---|---|
| （待补充） | core-engine / server | [domain/product/](./applications/core-engine/domain/product/README.md) |

> 新建正式 flow/state 知识时，请在本表补一行索引，避免「写了但路由找不到」。
