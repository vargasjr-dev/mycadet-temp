import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
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
    // module, and only index files aggregate a public surface.
    plugins: { "@mycadet": { rules: { "no-re-exports": noReExports } } },
    rules: { "@mycadet/no-re-exports": "error" },
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
