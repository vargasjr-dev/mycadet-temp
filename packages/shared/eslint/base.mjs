// @ts-check
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

import { importsFirst } from "./imports-first.mjs";
import { noEmptyImports } from "./no-empty-imports.mjs";
import { noReExports } from "./no-re-exports.mjs";

/**
 * The `@mycadet` plugin, wired once. Every shared custom rule registers
 * here; a service opts in by naming the rule (`@mycadet/imports-first`)
 * rather than re-assembling the plugin — flat config would overwrite a
 * same-named plugin definition wholesale, so one shared object identity
 * is what keeps adoption declarative.
 */
export const mycadetPlugin = {
  rules: {
    "imports-first": importsFirst,
    "no-empty-imports": noEmptyImports,
    "no-re-exports": noReExports,
  },
};

/**
 * The repo's lint floor: the rules every service already enforces,
 * declared once. Spread it first and add only what's yours — later
 * config items win.
 *
 * Re-export shims are outlawed everywhere: consumers import from the
 * defining module, and only index files aggregate a public surface.
 * Warning-level countdowns (cast bans, mock.module, namespace imports)
 * stay per-service — their pins are local.
 *
 * The floor carries the repo's build-output ignores so no service repeats
 * them: `dist/**`, `node_modules/**`, `.next/**`, `next-env.d.ts`,
 * `out/**`, `src/generated/**`, `storybook-static/**`, `drizzle/**`.
 */
export function baseEslintConfig() {
  return defineConfig([
    ...tseslint.configs.recommended,
    globalIgnores([
      "dist/**",
      "node_modules/**",
      ".next/**",
      "next-env.d.ts",
      "out/**",
      "src/generated/**",
      "storybook-static/**",
      "drizzle/**",
    ]),
    {
      plugins: { "@mycadet": mycadetPlugin },
      rules: {
        // Unused symbols are noise the compiler can't see (params kept
        // for signature shape, type-only imports); an underscore-prefixed
        // name declares the intent to keep.
        "@typescript-eslint/no-unused-vars": [
          "error",
          { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
        ],
        // Ban `as` casts at warning level: the cloud repo's rule. A cast
        // tells the checker to shut up; prefer zod schemas or
        // `in`-narrowing. The lint script pins --max-warnings to the
        // current count and each PR chips away at the remainder — PR 5
        // burns it to zero and flips this to error.
        "@typescript-eslint/consistent-type-assertions": [
          "warn",
          { assertionStyle: "never" },
        ],
        // A `let` assigned a value it can never read again is a dead
        // write — either the assignment is stale or the earlier value
        // was.
        "no-useless-assignment": "warn",
        "@mycadet/no-re-exports": "error",
      },
    },
  ]);
}
