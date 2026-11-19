import { defineConfig } from "eslint/config";

import { baseEslintConfig } from "@mycadet/shared/eslint/base";

const eslintConfig = defineConfig([
  ...baseEslintConfig(),
  {
    rules: {
      // Ban `as` casts outright (the cloud repo's rule) — prefer zod
      // schemas or `in`-narrowing. The client's cast debt was cleared, so
      // the lint script gates warnings at zero again.
      "@typescript-eslint/consistent-type-assertions": [
        "warn",
        { assertionStyle: "never" },
      ],
    },
  },
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
