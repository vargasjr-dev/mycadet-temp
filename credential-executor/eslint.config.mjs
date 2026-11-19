import { defineConfig } from "eslint/config";

import { baseEslintConfig } from "@mycadet/shared/eslint/base";

const eslintConfig = defineConfig([
  ...baseEslintConfig(),
  {
    files: ["src/__tests__/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
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
