import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import { noEmptyImports } from "@mycadet/shared/eslint/no-empty-imports";
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
    },
  },
  {
    // Re-export shims are outlawed: consumers import from the defining
    // module, and only index files aggregate a public surface. Warning
    // level with a pinned count — each PR chips away at the remainder.
    plugins: {
      "@mycadet": {
        rules: {
          "no-re-exports": noReExports,
          "no-empty-imports": noEmptyImports,
        },
      },
    },
    rules: {
      "@mycadet/no-re-exports": "error",
      "@mycadet/no-empty-imports": "error",
    },
  },
]);

export default eslintConfig;
