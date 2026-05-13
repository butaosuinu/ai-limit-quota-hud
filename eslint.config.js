// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["dist/**", "src-tauri/target/**", "src-tauri/gen/**", "node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["*.{js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // AGENTS.md: only Jotai is allowed for shared frontend state.
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "redux", message: "Use Jotai for shared frontend state (see AGENTS.md)." },
            { name: "@reduxjs/toolkit", message: "Use Jotai for shared frontend state (see AGENTS.md)." },
            { name: "zustand", message: "Use Jotai for shared frontend state (see AGENTS.md)." },
            { name: "recoil", message: "Use Jotai for shared frontend state (see AGENTS.md)." },
            { name: "mobx", message: "Use Jotai for shared frontend state (see AGENTS.md)." },
            { name: "mobx-react", message: "Use Jotai for shared frontend state (see AGENTS.md)." },
            { name: "xstate", message: "Use Jotai for shared frontend state (see AGENTS.md)." },
            { name: "@tanstack/react-query", message: "Use Jotai for shared frontend state (see AGENTS.md)." },
          ],
        },
      ],
    },
  },
);
