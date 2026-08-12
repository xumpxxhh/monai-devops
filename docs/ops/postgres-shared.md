# 团队公共 PostgreSQL（monai-devops）

本仓库**不再**自带 `docker compose` Postgres。开发与测试共用团队公共实例上的两个库：

| 库名 | 用途 |
|------|------|
| `monai_devops` | 日常开发（`.env` / `DATABASE_URL`） |
| `monai_devops_test` | Jest、e2e、`pnpm dev:test`（`.env.test`） |

连接串写在 `apps/server/.env`、`.env.test`（或 `.env.local` 覆盖）。库名须与上表一致。

## 首次建库

在公共实例上执行（按实际账号替换连接串）：

```bash
psql "postgresql://USER:PASSWORD@HOST:5432/postgres" -f docker/postgres/init-databases.sql
```

随后在 `apps/server` 执行迁移：

```bash
pnpm db:generate
pnpm db:migrate:dev    # → monai_devops
pnpm db:migrate:test   # → monai_devops_test
```

## 从本项目旧 compose 卷迁移数据

**在停掉旧容器、删除卷之前**完成导出。若仓库已去掉 compose，可临时用旧卷启动一次 Postgres 16 容器，或使用仍保留 `docker-compose.yml` 的提交 checkout 导出。

### 1. 确认旧数据容器与卷

旧 compose 默认卷名多为 `monai-devops_postgres_data`（以 `docker volume ls` 为准）。容器名示例：`monai-devops-postgres-1`。

若 compose 仍在仓库根：

```powershell
docker compose up -d postgres
```

### 2. 在公共库上建空库（若尚未创建）

见上文「首次建库」。**若公共库已有同名库且要覆盖**，先与团队确认，再 `DROP DATABASE` 或使用新库名（需同步改 `.env`）。

### 3. 导出（旧 compose Postgres）

在仓库根（compose 可用时）：

```powershell
docker compose exec -T postgres pg_dump -U monai -d monai_devops -Fc > monai_devops.dump
docker compose exec -T postgres pg_dump -U monai -d monai_devops_test -Fc > monai_devops_test.dump
```

若 compose 已删除，可在含 `docker-compose.yml` 的 git 提交上临时 checkout 该文件并 `docker compose up -d`，完成导出后再切回当前分支。

### 4. 导入公共实例

将 `SHARED_URL` 换为连到 `postgres` 库或目标库的 URL（需有 CREATE 权限）。示例用 `pg_restore`：

```powershell
# 开发库
pg_restore -d "postgresql://USER:PASSWORD@HOST:5432/monai_devops" --clean --if-exists --no-owner --no-acl monai_devops.dump

# 测试库
pg_restore -d "postgresql://USER:PASSWORD@HOST:5432/monai_devops_test" --clean --if-exists --no-owner --no-acl monai_devops_test.dump
```

`--clean` 会删对象再恢复；公共库若已有他人数据，**务必先备份并协调**。

### 5. 切换应用并验证

1. 更新 `apps/server/.env`、`.env.test` 中 `DATABASE_URL` 指向公共 host。
2. `pnpm dev:server`，确认启动日志 `Using database: monai_devops`。
3. 跑 `pnpm --filter server test` 与 `pnpm --filter server test:e2e`（e2e 依赖测试库）。

### 6. 下线旧 compose

```powershell
docker compose down
# 确认无依赖后再删卷（不可恢复）：
# docker volume rm monai-devops_postgres_data
```

## 共享库协作注意

- **开发库共享**：`prisma migrate dev` 会改全员 schema；迁移请走评审/约定窗口，生产式环境用 `db:migrate`（deploy）。
- **测试库共享**：集成测 / e2e 会 `deleteMany` 部分表；避免多人同时跑全量 e2e，或在团队时段内协调。
- **版本**：公共 Postgres 建议 ≥ 16，与历史 compose 镜像一致。
