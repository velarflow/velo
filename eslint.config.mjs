// VelarFlow — eslint.config.mjs (ESLint 9 flat config)
// ────────────────────────────────────────────────────────────────────────────
// MUST-2: no-control-regex jest wyłączone — stripCtrl celowo używa regexów
// z znakami kontrolnymi (to jest sanitizer). Lokalne eslint-disable w kodzie.
// ────────────────────────────────────────────────────────────────────────────

import js from "@eslint/js";
import reactPlugin from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    files: ["**/*.jsx", "**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        ...globals.browser,
        ...globals.es2024,
        // MUST-3: __VELARFLOW_DEMO__ jest podstawiany przez Vite w czasie buildu.
        // ESLint widzi go jako "niezdefiniowany" — deklarujemy jako readonly global.
        __VELARFLOW_DEMO__: "readonly",
      },
    },
    plugins: {
      react: reactPlugin,
      "react-hooks": reactHooks,
    },
    settings: { react: { version: "18.0" } },
    rules: {
      // KRYTYCZNE — bez nich JSX nie wie że <Foo/> używa identyfikatora Foo
      "react/jsx-uses-vars": "error",
      "react/jsx-uses-react": "error",

      // Correctness (errors)
      "no-undef": "error",
      "no-redeclare": "error",
      "no-dupe-keys": "error",
      "no-dupe-args": "error",
      "no-unreachable": "error",
      "no-self-compare": "error",
      "no-unsafe-negation": "error",
      "valid-typeof": "error",
      "use-isnan": "error",
      "no-useless-escape": "error",
      "react/jsx-key": "error",
      "react/jsx-no-duplicate-props": "error",
      "react/jsx-no-undef": "error",
      "react/no-direct-mutation-state": "error",
      "react-hooks/rules-of-hooks": "error",

      // Quality (warnings — nie blokują CI)
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-empty": "warn",
      "no-constant-condition": "warn",
      "no-cond-assign": "warn",
      "eqeqeq": ["warn", "smart"],
      "react/no-array-index-key": "warn",
      "react/no-children-prop": "warn",
      "react/no-unescaped-entities": "warn",
      "react-hooks/exhaustive-deps": "warn",

      // MUST-2: no-control-regex wyłączone GLOBALNIE bo stripCtrl tego potrzebuje.
      // Alternatywa: zostawić error i użyć eslint-disable-next-line lokalnie (już zrobione).
      // Wybieram drugie podejście — bezpieczniej, niech reguła wyłapie nowe przypadki.
      "no-control-regex": "error",
    },
  },
];
