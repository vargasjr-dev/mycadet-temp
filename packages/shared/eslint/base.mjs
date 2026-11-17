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
 * @param {{ ignores?: string[] }} [options]
 * Extra global ignores for service build output (e.g. `drizzle/**`).
 * `dist/**` is always ignored.
 */
export function baseEslintConfig(options = {}) {
  const { ignores = [] } = options;
  return defineConfig([
    ...tseslint.configs.recommended,
    globalIgnores(["dist/**", ...ignores]),
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
        "@mycadet/no-re-exports": "error",
      },
    },
  ]);
}
