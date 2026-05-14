import js from "@eslint/js";
import tseslint from "typescript-eslint";
import love from "eslint-config-love";
import functional from "eslint-plugin-functional";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";

export default tseslint.config(
  {
    ignores: [
      "dist/",
      "coverage/",
      "node_modules/",
      "eslint.config.js",
      "vite.config.ts",
      "vitest.config.ts",
      "src-tauri/target/",
      "src-tauri/gen/",
      "src/types/**/*.d.ts",
      ".claude/",
      ".mcp.json",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  love,
  functional.configs.strict,
  {
    plugins: {
      "react-hooks": reactHooks,
      "jsx-a11y": jsxA11y,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      "@typescript-eslint/no-magic-numbers": [
        "warn",
        {
          ignore: [-1, 0, 1, 2, 100, 1000, 60_000, 86_400_000],
          ignoreEnums: true,
          ignoreNumericLiteralTypes: true,
          ignoreReadonlyClassProperties: true,
          ignoreTypeIndexes: true,
          ignoreDefaultValues: true,
          ignoreClassFieldInitialValues: true,
        },
      ],
      "@typescript-eslint/explicit-function-return-type": "off",
      "functional/prefer-immutable-types": "off",
      "functional/type-declaration-immutability": "off",
      "functional/functional-parameters": [
        "error",
        { enforceParameterCount: false },
      ],
      "functional/no-conditional-statements": [
        "error",
        { allowReturningBranches: true },
      ],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-restricted-syntax": [
        "error",
        {
          selector: "TryStatement",
          message:
            "try/catch is forbidden. Use the await/catch pattern: `const result = await expr.catch(handler)`",
        },
        {
          selector:
            "CallExpression > MemberExpression.callee[property.name='then']",
          message:
            ".then() is forbidden. Use the await/catch pattern: `const result = await expr.catch(handler)`",
        },
        {
          selector: "ExportAllDeclaration",
          message:
            "バレル再エクスポート（`export *`）禁止。直接 import パスを使用すること（AGENTS.md TypeScript Guidelines）",
        },
        {
          selector: "CallExpression[callee.name='useEffect'] AwaitExpression",
          message:
            "useEffect 内での非同期データ取得は禁止 (await)。Suspense + Jotai async atom を使用すること（AGENTS.md React Suspense パターン）",
        },
        {
          selector:
            "CallExpression[callee.name='useEffect'] ArrowFunctionExpression[async=true]",
          message:
            "useEffect の引数を async 関数にすることは禁止。Suspense + Jotai async atom を使用すること（AGENTS.md React Suspense パターン）",
        },
        {
          selector:
            "CallExpression[callee.name='useEffect'] FunctionExpression[async=true]",
          message:
            "useEffect の引数を async 関数にすることは禁止。Suspense + Jotai async atom を使用すること（AGENTS.md React Suspense パターン）",
        },
        {
          selector:
            "CallExpression[callee.name='useEffect'] CallExpression[callee.type='MemberExpression'][callee.property.name='catch']",
          message:
            "useEffect 内での Promise チェーン (.catch) は禁止。fire-and-forget な非同期処理は Suspense + Jotai async atom に置き換えること（AGENTS.md React Suspense パターン）",
        },
        {
          selector:
            "CallExpression[callee.name='useEffect'] CallExpression[callee.type='MemberExpression'][callee.property.name='finally']",
          message:
            "useEffect 内での Promise チェーン (.finally) は禁止。Suspense + Jotai async atom を使用すること（AGENTS.md React Suspense パターン）",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "redux",
              message: "Use Jotai for shared frontend state (see AGENTS.md).",
            },
            {
              name: "@reduxjs/toolkit",
              message: "Use Jotai for shared frontend state (see AGENTS.md).",
            },
            {
              name: "zustand",
              message: "Use Jotai for shared frontend state (see AGENTS.md).",
            },
            {
              name: "recoil",
              message: "Use Jotai for shared frontend state (see AGENTS.md).",
            },
            {
              name: "mobx",
              message: "Use Jotai for shared frontend state (see AGENTS.md).",
            },
            {
              name: "mobx-react",
              message: "Use Jotai for shared frontend state (see AGENTS.md).",
            },
            {
              name: "xstate",
              message: "Use Jotai for shared frontend state (see AGENTS.md).",
            },
            {
              name: "@tanstack/react-query",
              message: "Use Jotai for shared frontend state (see AGENTS.md).",
            },
          ],
        },
      ],
      "@typescript-eslint/max-params": ["error", { max: 3 }],
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["src/components/error/ErrorBoundary.tsx"],
    rules: {
      "functional/no-classes": "off",
      "functional/no-class-inheritance": "off",
      "functional/no-this-expressions": "off",
      "functional/no-expression-statements": "off",
      "functional/no-conditional-statements": "off",
      "functional/no-return-void": "off",
      "@typescript-eslint/class-methods-use-this": "off",
      "no-console": "off",
    },
  },
  {
    files: [
      "src/components/**/*.tsx",
      "src/lib/components/**/*.tsx",
      "src/App.tsx",
      "src/main.tsx",
    ],
    rules: {
      "functional/no-expression-statements": "off",
      "functional/no-return-void": "off",
      "functional/no-conditional-statements": "off",
      "functional/no-mixed-types": "off",
      "functional/immutable-data": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/strict-boolean-expressions": "off",
      "@typescript-eslint/strict-void-return": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/prefer-destructuring": "off",
      "@typescript-eslint/no-unsafe-type-assertion": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "functional/no-throw-statements": "off",
      "no-negated-condition": "off",
      "require-unicode-regexp": "off",
    },
  },
  {
    files: ["src/lib/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
  {
    files: ["src/state/**/*.ts", "src/lib/atoms/**/*.ts"],
    rules: {
      "functional/no-expression-statements": "off",
      "functional/no-return-void": "off",
      "functional/no-classes": "off",
      "functional/no-class-inheritance": "off",
      "functional/no-this-expressions": "off",
      "functional/immutable-data": "off",
      "functional/no-let": "off",
      "functional/no-conditional-statements": "off",
      "no-console": "off",
      "no-param-reassign": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/promise-function-async": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-type-assertion": "off",
    },
  },
  {
    files: ["src/hooks/**/*.ts"],
    rules: {
      "functional/no-expression-statements": "off",
      "functional/no-return-void": "off",
      "functional/no-conditional-statements": "off",
      "functional/no-throw-statements": "off",
      "functional/immutable-data": "off",
      "no-restricted-syntax": [
        "error",
        {
          selector: "TryStatement",
          message:
            "try/catch is forbidden. Use the await/catch pattern: `const result = await expr.catch(handler)`",
        },
        {
          selector:
            "CallExpression > MemberExpression.callee[property.name='then']",
          message:
            ".then() is forbidden. Use the await/catch pattern: `const result = await expr.catch(handler)`",
        },
        {
          selector: "ExportAllDeclaration",
          message:
            "バレル再エクスポート（`export *`）禁止。直接 import パスを使用すること（AGENTS.md TypeScript Guidelines）",
        },
      ],
    },
  },
  {
    files: ["**/*.d.ts"],
    rules: {
      "@typescript-eslint/consistent-type-definitions": "off",
      "@typescript-eslint/triple-slash-reference": "off",
    },
  },
  {
    files: [
      "**/*.test.ts",
      "**/*.test.tsx",
      "src/test/**/*.ts",
      "src/test/**/*.tsx",
    ],
    rules: {
      "functional/no-expression-statements": "off",
      "functional/no-return-void": "off",
      "functional/no-conditional-statements": "off",
      "functional/immutable-data": "off",
      "functional/no-loop-statements": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-type-assertion": "off",
      "@typescript-eslint/consistent-type-assertions": "off",
      "@typescript-eslint/consistent-type-imports": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/strict-void-return": "off",
      "@typescript-eslint/naming-convention": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-magic-numbers": "off",
      "@eslint-community/eslint-comments/require-description": "off",
      "max-nested-callbacks": "off",
      complexity: "off",
      "promise/avoid-new": "off",
      "no-promise-executor-return": "off",
      "no-await-in-loop": "off",
      "no-console": "off",
      "@typescript-eslint/max-params": "off",
      "@typescript-eslint/promise-function-async": "off",
      "@typescript-eslint/require-await": "off",
      "require-unicode-regexp": "off",
    },
  },
);
