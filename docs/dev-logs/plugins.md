# plugins 开发日志

## 2026-08-14

- **变更**：`shell-exec-plugin` 新增可选 Docker sandbox（`sandbox: docker`），容器内执行命令并挂载 workspace；bridge 网络自动注入 `host.docker.internal`；CI 示例改为 docker sandbox + 容器内连库地址
- **文件**：`plugins/shell-exec-plugin/src/`, `docs/examples/ci-pipeline-poc.workflow.json`, `apps/server/.env.example`

## 2026-08-13

- **变更**：新增 `file-inject-plugin`，按相对 `workspaceDir` 的路径写入文件内容；示例 CI 流水线在 checkout 后注入 `apps/server/.env`
- **文件**：`plugins/file-inject-plugin/`, `apps/server/plugins.config.json`, `docs/examples/ci-pipeline-poc.workflow.json`

## 2026-08-12

- **变更**：新增 CI PoC 插件 `git-checkout-plugin`（clone/checkout 到 workspaceDir）与 `shell-exec-plugin`（工作区内 shell 执行，含超时/取消与 cwd 逃逸校验）；示例工作流见 `docs/examples/ci-pipeline-poc.workflow.json`
- **文件**：`plugins/git-checkout-plugin/`, `plugins/shell-exec-plugin/`, `apps/server/plugins.config.json`, `docs/examples/ci-pipeline-poc.workflow.json`
