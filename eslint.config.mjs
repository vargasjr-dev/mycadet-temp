import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";

import { baseEslintConfig } from "@mycadet/shared/eslint/base";

export default defineConfig([
  ...baseEslintConfig({
    ignores: [
      "packages/*/dist/**",
      "packages/*/node_modules/**",
      "packages/*/storybook-static/**",
    ],
  }),
  {
    // Design-library's tsx carries eslint-disable directives for the
    // react-hooks rules; register the plugin so the directives resolve
    // without enabling the rules here.
    plugins: { "react-hooks": reactHooks },
  },
  {
    // First-ever lint for packages/*: the floor's structural debts (unused
    // vars, re-export shims) start as a pinned countdown — each PR chips
    // away at the count instead of landing a mass rewrite.
    files: ["packages/*/src/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": "warn",
      "@mycadet/no-re-exports": "warn",
    },
  },
]);
