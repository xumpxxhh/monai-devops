# apps/web 开发日志

## 2026-08-05

- **变更**：JSON Schema 表单增强 — object/array 用 CodeEditor 编辑、boolean 用 Switch 替代 Checkbox、引用类型兼容性校验（`resolveSchemaAtPath` + `areJsonTypesCompatible` + `validateContextRefType`）、enum 值保持原始类型、`literalFallbackForProp`；编辑器面板适配 state ref — SetState 字段从 stateSchema 选择+路径用 Cascader、WorkflowRef 用 Modal+JsonSchemaForm 编辑 inputState 与循环配置、引用源增加工作流 State；`useLayoutEffect` 修复 setNodes 回调中 setState 时机问题；透传 `referenceSources` 到插件表单校验；新增 `@radix-ui/react-switch` 依赖与 Switch 组件
- **文件**：`shared/ui/json-schema-form/*`, `shared/ui/form/Switch.tsx`, `shared/ui/form/index.ts`, `shared/plugins/*`, `features/editor/BuiltinStepPanels.tsx`, `features/editor/StepInspectorPanel.tsx`, `features/editor/WorkflowEditorPage.tsx`, `shared/types/index.ts`, `package.json`

## 2026-07-27

- **变更**：新增 CodeMirror 6 代码编辑器基础组件（`CodeEditor` + `language` 注册表），支持 json/plain 语法高亮与 JSON lint，对齐 Field 表单与 Control Room 主题；Test 页附演示区
- **文件**：`src/shared/ui/code-editor/*`, `src/pages/Test.tsx`, `package.json`

## 2026-07-24

- **变更**：README 同步可组合编辑器与运行详情嵌套日志能力
- **文件**：`README.md`
- **变更**：阶段 5 工作流可组合化前端：多 kind 编辑器、导入/stateSchema、运行详情 parent/迭代聚合
- **文件**：`src/features/editor/*`, `src/features/workflows/WorkflowsListPage.tsx`, `src/features/run-detail/*`, `src/shared/api/workflows.ts`, `src/shared/api/runs.ts`, `src/shared/types/index.ts`
- **变更**：子 run 并入父后，运行详情去掉 children 跳转，迭代抽屉展示嵌套日志；防御无 parent 的异 runId 事件不污染 DAG
- **文件**：`src/features/run-detail/RunDetailPage.tsx`, `src/features/run-detail/run-state.ts`, `src/features/run-detail/run-state.test.ts`
- **变更**：嵌套日志按 nesting 分组折叠展示 + 等宽字体改为 @fontsource/jetbrains-mono 本地化加载
- **文件**：`src/features/run-detail/RunDetailPage.tsx`, `src/features/run-detail/run-state.ts`, `src/index.css`, `src/main.tsx`
- **变更**：编辑器组件拆分（EditableWorkflowTitle、StepInspectorPanel、WorkflowSettingsModal、workflow-name）+ palette 新增 workflow-import 类型（已导入子工作流直接拖入画布）+ 步骤名重复前端校验
- **文件**：`src/features/editor/*`, `src/shared/utils/format-time.ts`

## 2026-07-01

- **变更**：从 Vite 脚手架升级为可演示控制台；对接 server REST/WS；落地 7 个业务视图与 Radix+Tailwind 表单组件
- **文件**：`src/App.tsx`, `src/layouts/*`, `src/features/*`, `src/shared/api/*`, `src/shared/ui/*`, `src/config/env.ts`, `tailwind.config.js`
