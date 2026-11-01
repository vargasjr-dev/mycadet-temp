/**
 * `@mycadet/eslint-plugin` — rules shared by every package's flat config.
 *
 * Import it in an `eslint.config.mjs` and register it under a plugin key:
 *
 * ```js
 * import mycadet from "@mycadet/eslint-plugin";
 *
 * plugins: { "@mycadet": mycadet },
 * rules: { "@mycadet/no-re-exports": "warn" },
 * ```
 */
import noReExports from "./no-re-exports.mjs";

const plugin = {
  meta: { name: "@mycadet/eslint-plugin" },
  rules: {
    "no-re-exports": noReExports,
  },
};

export default plugin;
