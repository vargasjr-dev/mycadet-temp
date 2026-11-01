/**
 * Unit tests for the no-re-exports ESLint rule.
 *
 * Run with: `bun test packages/eslint-plugin/no-re-exports.test.mjs`
 *
 * A passing run prints "Ran 0 tests". That is a reporting artifact, not a
 * skip: bun does not expose `describe` / `it` as globals to `.mjs`, so
 * `RuleTester` falls back to its own inline runner and never registers with
 * bun's reporter. The cases still execute, a wrong expectation still throws,
 * and the process still exits non-zero. Verify by breaking a case on purpose.
 */
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";

import { noReExports } from "./no-re-exports.mjs";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: "latest",
    sourceType: "module",
  },
});

ruleTester.run("no-re-exports", noReExports, {
  valid: [
    {
      name: "a module exporting what it defines is fine",
      code: [
        'import { helper } from "./helper.js";',
        "",
        "export function local() {",
        "  return helper();",
        "}",
      ].join("\n"),
    },
    {
      name: "a bare export of a locally-defined binding is fine, even in a file that imports",
      code: [
        'import { helper } from "./helper.js";',
        "",
        "const thing = helper();",
        "",
        "export { thing };",
      ].join("\n"),
    },
    {
      name: "a new const binding wrapping an import is a wrapper, not a re-export",
      code: [
        'import { Client } from "./client.js";',
        "",
        "export const sharedClient = new Client();",
      ].join("\n"),
    },
    {
      name: "index files may aggregate fused re-exports",
      code: [
        'export { alpha } from "./alpha.js";',
        'export type { Beta } from "./beta.js";',
      ].join("\n"),
      filename: "/repo/packages/some-pkg/src/index.ts",
    },
    {
      name: "index files may aggregate star re-exports",
      code: 'export * from "./alpha.js";',
      filename: "/repo/packages/some-pkg/index.mjs",
    },
    {
      name: "index files may re-export their imports",
      code: [
        'import { alpha } from "./alpha.js";',
        "",
        "export { alpha };",
      ].join("\n"),
      filename: "/repo/packages/some-pkg/index.js",
    },
    {
      name: "default exports of locally-defined things are fine",
      code: [
        'import { helper } from "./helper.js";',
        "",
        "export default function local() {",
        "  return helper();",
        "}",
      ].join("\n"),
    },
  ],

  invalid: [
    {
      name: "fused value re-export",
      code: 'export { alpha } from "./alpha.js";',
      errors: [{ messageId: "exportFrom" }],
    },
    {
      name: "index exemption is basename-only: index-helper.ts is still an outlaw",
      code: 'export { alpha } from "./alpha.js";',
      filename: "/repo/packages/some-pkg/src/index-helper.ts",
      errors: [{ messageId: "exportFrom" }],
    },
    {
      name: "fused type re-export",
      code: 'export type { Beta } from "./beta.js";',
      errors: [{ messageId: "exportFrom" }],
    },
    {
      name: "star re-export",
      code: 'export * from "./alpha.js";',
      errors: [{ messageId: "exportStar" }],
    },
    {
      name: "star-as re-export",
      code: 'export * as ns from "./alpha.js";',
      errors: [{ messageId: "exportStar" }],
    },
    {
      name: "shim form: import then bare export",
      code: [
        'import { alpha } from "./alpha.js";',
        "",
        "export { alpha };",
      ].join("\n"),
      errors: [{ messageId: "reExportedImport" }],
    },
    {
      name: "shim form under a new name",
      code: [
        'import { alpha } from "./alpha.js";',
        "",
        "export { alpha as beta };",
      ].join("\n"),
      errors: [{ messageId: "reExportedImport" }],
    },
    {
      name: "type-only shim form",
      code: [
        'import type { Alpha } from "./alpha.js";',
        "",
        "export type { Alpha };",
      ].join("\n"),
      errors: [{ messageId: "reExportedImport" }],
    },
    {
      name: "the import can trail the export (imports hoist)",
      code: [
        "export { alpha };",
        "",
        'import { alpha } from "./alpha.js";',
      ].join("\n"),
      errors: [{ messageId: "reExportedImport" }],
    },
    {
      name: "several shims in one file each report",
      code: [
        'import { alpha, beta } from "./alpha.js";',
        'import { gamma } from "./gamma.js";',
        "",
        "export { alpha, beta, gamma };",
      ].join("\n"),
      errors: [
        { messageId: "reExportedImport" },
        { messageId: "reExportedImport" },
        { messageId: "reExportedImport" },
      ],
    },
  ],
});
