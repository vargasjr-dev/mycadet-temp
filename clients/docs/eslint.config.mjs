import { defineConfig } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

import { baseEslintConfig } from "@mycadet/shared/eslint/base";

const eslintConfig = defineConfig([
  ...nextCoreWebVitals,
  // Adds 19 typescript-eslint rules that core-web-vitals does not enable,
  // plus the repo's lint floor.
  ...baseEslintConfig(),
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: {
      // An explicit version skips eslint-plugin-react's autodetection, which
      // calls a context API that ESLint 10 removed.
      react: { version: "19.2" },
    },
    rules: {
      // Braces on every control-statement body; see root AGENTS.md.
      curly: ["error", "all"],
    },
  },
]);

export default eslintConfig;
