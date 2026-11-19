import { defineConfig } from "eslint/config";

import { baseEslintConfig } from "@mycadet/shared/eslint/base";

const eslintConfig = defineConfig([
  ...baseEslintConfig(),
  {
    rules: {
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
