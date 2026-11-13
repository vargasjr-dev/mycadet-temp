import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import { noEmptyImports } from "@mycadet/shared/eslint/no-empty-imports";
import { noReExports } from "@mycadet/shared/eslint/no-re-exports";

const eslintConfig = defineConfig([
  ...tseslint.configs.recommended,
  globalIgnores(["dist/**", "out/**"]),
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
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
    // Re-export shims are outlawed: consumers import from the defining
    // module, and only index files aggregate a public surface.
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
