import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import { importsFirst } from "@mycadet/shared/eslint/imports-first";
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
    files: ["src/__tests__/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // Re-export shims are outlawed: consumers import from the defining
    // module, and only index files aggregate a public surface. Warning
    // level with a pinned count — each PR chips away at the remainder.
    plugins: {
      "@mycadet": {
        rules: { "no-re-exports": noReExports, "imports-first": importsFirst },
      },
    },
    rules: { "@mycadet/no-re-exports": "error", "@mycadet/imports-first": "error" },
  },
]);

export default eslintConfig;
