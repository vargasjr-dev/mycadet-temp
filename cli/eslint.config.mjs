import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import { noReExports } from "@mycadet/shared/eslint/no-re-exports";

const eslintConfig = defineConfig([
  ...tseslint.configs.recommended,
  globalIgnores(["dist/**"]),
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Ban `as` casts (the cloud repo's rule) at warning level: the
      // lint script pins --max-warnings to the current count and each PR
      // chips away at it — prefer zod schemas or `in`-narrowing.
      "@typescript-eslint/consistent-type-assertions": [
        "warn",
        { assertionStyle: "never" },
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
