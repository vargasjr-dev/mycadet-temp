import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

const eslintConfig = defineConfig([
  ...tseslint.configs.recommended,
  globalIgnores(["dist/**"]),
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Ban `as` casts (the platform repo's rule) at warning level: the
      // lint script pins --max-warnings to the current count and each PR
      // chips away at it — prefer zod schemas or `in`-narrowing.
      "@typescript-eslint/consistent-type-assertions": [
        "warn",
        { assertionStyle: "never" },
      ],
    },
  },
]);

export default eslintConfig;
