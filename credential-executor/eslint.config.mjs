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
    plugins: { "@mycadet": { rules: { "no-re-exports": noReExports } } },
    rules: { "@mycadet/no-re-exports": "error" },
  },
  {
    // Namespace imports (`import * as ns`) hide which members the consumer
    // actually uses, and knip cannot attribute members through every
    // namespace shape — import the named members instead. Test files are
    // exempt (the block below): the mock.module seam idiom spreads
    // namespaces by design.
    rules: {
      "no-restricted-syntax": [
        "warn",
        {
          selector: "ImportDeclaration > ImportNamespaceSpecifier",
          message:
            "Namespace imports hide the used surface — import the named members instead.",
        },
      ],
    },
  },
  {
    files: ["src/__tests__/**"],
    rules: { "no-restricted-syntax": "off" },
  },
]);

export default eslintConfig;
