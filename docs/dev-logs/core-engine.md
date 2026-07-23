# @monai-devops/core-engine 开发日志

## 2026-07-06

- **变更**：补齐 Run 注册与 cancel/pause/resume；observer 增加控制事件；终态支持 `cancelled`；hard cancel / abortInFlight 预埋
- **文件**：`executor/run-registry.ts`, `executor/run-handle.ts`, `executor/index.ts`, `engine/index.ts`, `scheduler/index.ts`, `observer/*`, `__tests__/executor-run-control.test.ts`
