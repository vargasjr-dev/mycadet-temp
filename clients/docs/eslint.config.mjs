import { defineConfig, globalIgnores } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import tseslint from "typescript-eslint";
import { noReExports } from "@mycadet/shared/eslint/no-re-exports";

const eslintConfig = defineConfig([
  ...nextCoreWebVitals,
  // Adds 19 typescript-eslint rules that core-web-vitals does not enable.
  ...tseslint.configs.recommended,
  globalIgnores(["node_modules/**", ".next/**", "next-env.d.ts"]),
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
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Re-export shims are outlawed: consumers import from the defining
    // module, and only index files aggregate a public surface. Warning
    // level with a pinned count — each PR chips away at the remainder.
    plugins: { "@mycadet": { rules: { "no-re-exports": noReExports } } },
    rules: { "@mycadet/no-re-exports": "error" },
  },
]);

export default eslintConfig;
