/**
 * Unit tests for the no-empty-imports ESLint rule.
 *
 * Run with: `bun test packages/shared/eslint/no-empty-imports.test.mjs`
 *
 * A passing run prints "Ran 0 tests". That is a reporting artifact, not a
 * skip: bun does not expose `describe` / `it` as globals to `.mjs`, so
 * `RuleTester` falls back to its own inline runner and never registers with
 * bun's reporter. The cases still execute, a wrong expectation still throws,
 * and the process still exits non-zero. Verify by breaking a case on purpose.
 */
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";

import { noEmptyImports } from "./no-empty-imports.mjs";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: "latest",
    sourceType: "module",
  },
});

ruleTester.run("no-empty-imports", noEmptyImports, {
  valid: [
    {
      name: "a bare side-effect import is the honest shape and survives",
      code: 'import "./auto-update.client";',
    },
    {
      name: "an import that binds names survives",
      code: 'import { applyEdit } from "./edit-engine.js";',
    },
    {
      name: "a type import that binds names survives",
      code: 'import type { EditEngineResult } from "./edit-engine.js";',
    },
    {
      name: "a namespace import survives (unused ns is no-unused-vars' job)",
      code: 'import type * as protocol from "./message-protocol.js";',
    },
    {
      name: "a default import survives",
      code: 'import log from "./logger.js";',
    },
  ],

  invalid: [
    {
      name: "empty type import — the knip-sweep husk",
      code: 'import type {} from "../tools/shared/filesystem/edit-engine.js";',
      errors: [{ messageId: "emptyTypeImport" }],
    },
    {
      name: "empty type import of a builtin",
      code: 'import type {} from "bun:sqlite";',
      errors: [{ messageId: "emptyTypeImport" }],
    },
    {
      name: "empty named value import",
      code: 'import {} from "./fixtures/edge-swipe";',
      errors: [{ messageId: "emptyImport" }],
    },
    {
      name: "spaced-out braces still count",
      code: 'import {  } from "./x.js";',
      errors: [{ messageId: "emptyImport" }],
    },
  ],
});
