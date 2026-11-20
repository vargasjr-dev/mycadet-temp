import { defineConfig } from "eslint/config";

import { baseEslintConfig } from "@mycadet/shared/eslint/base";

const eslintConfig = defineConfig([
  ...baseEslintConfig(),
  {
    rules: {
      "no-restricted-syntax": [
        "warn",
        {
          selector: "ImportDeclaration > ImportNamespaceSpecifier",
          message: "Namespace imports hide the used surface.",
        },
      ],
    },
  },
  {
    files: ["**/__tests__/**/*.ts", "**/*.test.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
]);

export default eslintConfig;
