import { defineConfig } from "eslint/config";

import { baseEslintConfig } from "@mycadet/shared/eslint/base";

const eslintConfig = defineConfig([
  ...baseEslintConfig(),
  {
    // The plugin registers in the shared floor; this only opts macos into
    // the no-empty-imports rule.
    rules: { "@mycadet/no-empty-imports": "error" },
  },
  {
    // Tests may use `any` freely — fixtures and mocks don't earn real types.
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    // electron-builder hooks and fixture servers are CommonJS by contract:
    // electron-builder loads them via require(), long after bun's ESM world.
    files: ["**/*.cjs", "scripts/**/*.js"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
]);

export default eslintConfig;
