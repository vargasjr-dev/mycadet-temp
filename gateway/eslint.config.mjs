import { defineConfig } from "eslint/config";

import { baseEslintConfig } from "@mycadet/shared/eslint/base";

const eslintConfig = defineConfig([
  ...baseEslintConfig(),
  {
    rules: {
      "@mycadet/imports-first": "error",
      // Lone blocks pretend to scope — they hide nothing and read like a bug.
      "no-lone-blocks": "error",
    },
  },
  {
    files: ["src/__tests__/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
]);

export default eslintConfig;
