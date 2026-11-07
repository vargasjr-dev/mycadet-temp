/**
 * Unit tests for the imports-first ESLint rule.
 *
 * Run with: `bun test packages/shared/eslint/imports-first.test.mjs`
 *
 * Like no-re-exports' suite: a passing run prints "Ran 0 tests" (a bun
 * `.mjs` reporting artifact) — the cases still execute and a wrong
 * expectation still throws with a non-zero exit.
 */
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";

import { importsFirst } from "./imports-first.mjs";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: "latest",
    sourceType: "module",
  },
});

ruleTester.run("imports-first", importsFirst, {
  valid: [
    {
      name: "imports at the top, then statements",
      code: [
        'import { helper } from "./helper.js";',
        'import type { Shape } from "./shape.js";',
        "",
        "export const x: Shape = helper();",
      ].join("\n"),
    },
    {
      name: "comments between imports are not statements",
      code: [
        'import { helper } from "./helper.js";',
        "",
        "// A section comment.",
        "// Another line of it.",
        'import { other } from "./other.js";',
        "",
        "export const y = other();",
      ].join("\n"),
    },
    {
      name: "a module with only imports",
      code: ['import { helper } from "./helper.js";'].join("\n"),
    },
  ],
  invalid: [
    {
      name: "an import after a statement is flagged",
      code: [
        'import { helper } from "./helper.js";',
        "",
        "export const x = helper();",
        "",
        'import { other } from "./other.js";',
        "",
        "export const y = other();",
      ].join("\n"),
      errors: [{ messageId: "hoist" }],
    },
    {
      name: "each late import is flagged once",
      code: [
        "export const x = 1;",
        'import { helper } from "./helper.js";',
        'import { other } from "./other.js";',
        "",
        "export const y = helper() + other();",
      ].join("\n"),
      errors: [{ messageId: "hoist" }, { messageId: "hoist" }],
    },
  ],
});
