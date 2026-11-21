import { defineConfig } from "eslint/config";

import { baseEslintConfig } from "@mycadet/shared/eslint/base";

const eslintConfig = defineConfig([
  ...baseEslintConfig(),
  {
    // languageOptions: {
    //   parserOptions: {
    //     tsconfigRootDir: import.meta.dirname,
    //   },
    // },
    // Dead symbols and re-export shims are real debt, but deleting them is
    // its own PR series — warning level with a pinned count lets the floor
    // land first and each PR chips away at the remainder.
    rules: {
      "@mycadet/no-re-exports": "warn",
      "@typescript-eslint/no-unused-vars": "warn",
    },
  },
]);

export default eslintConfig;
