import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/",
      "dist/",
      "coverage/",
      "packages/app/e2e/test-results/",
      "packages/app/e2e/visual-proof/",
      "packages/app/test-results/",
      "packages/answer.js",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: tseslint.configs.recommended,
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-unsafe-function-type": "off",
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    rules: {
      "no-process-exit": "warn",
      "no-useless-escape": "off",
      "no-empty-pattern": "warn",
      "no-async-promise-executor": "warn",
      "no-constant-condition": "warn",
      "no-useless-assignment": "warn",
      "prefer-const": "warn",
      "preserve-caught-error": "off",
    },
  },
  {
    files: ["**/*.test.ts", "**/*.spec.ts"],
    rules: {
      "no-process-exit": "off",
    },
  },
);
