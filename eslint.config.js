import js from "@eslint/js";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import prettierPlugin from "eslint-plugin-prettier"; // 插件
import prettierConfig from "eslint-config-prettier"; // 配置（用于关闭冲突规则）
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist",
      "**/node_modules",
      "**/.turbo",
      "**/.next",
      "**/coverage",
      "**/.vscode",
      "**/*.cjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      react,
      "react-hooks": reactHooks,
      prettier: prettierPlugin, // 这里注册插件
    },
    languageOptions: {
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    settings: {
      react: {
        version: "detect",
      },
    },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      "prettier/prettier": "error", // 启用 Prettier 格式检查
      "react/react-in-jsx-scope": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-empty-object-type": "off",
    },
  },
  // 在最后添加 prettierConfig，用于禁用冲突规则
  prettierConfig
);