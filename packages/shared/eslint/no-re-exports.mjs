// @ts-check
/**
 * `no-re-exports` — outlaw re-exports of imports outside index files.
 *
 * A file that imports a binding only to export it again (`export { x } from
 * "y"`, `export * from "y"`, or `import { x } from "y"` + `export { x }`) is
 * a re-export shim: it hides the true dependency graph, gives the binding a
 * second home that drifts from its defining module, and earns the same
 * review comment every time — delete the re-export and update the consumers.
 * This rule encodes that review.
 *
 * Index files (a file named `index.ts`/`index.js`/…) are the one exception:
 * they are the package's public surface and may aggregate exports from the
 * modules beside them. Everything else must make consumers import from the
 * defining module directly.
 *
 * Flagged shapes:
 * - `export { x } from "y"` and `export type { x } from "y"` (fused re-export)
 * - `export * from "y"` and `export * as ns from "y"` (star re-export)
 * - `import { x } from "y"` + `export { x }` / `export { x as z }` (shim form,
 *   including the type-only variants of both halves)
 *
 * Not flagged: `export const x = y` — it binds a NEW name this file owns
 * (a wrapper, not a re-export); if that wrapper is redundant, that is a
 * deletion to make in review, not a lint error here.
 */

import { basename } from "node:path";

/** File extensions an index file may carry. */
const INDEX_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
]);

/**
 * Whether the linted file is an index file, which may aggregate exports.
 * `context.filename` is the absolute path; only the basename matters.
 */
function isIndexFile(filename) {
  const base = basename(filename);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return (
    base.slice(0, dot) === "index" &&
    INDEX_EXTENSIONS.has(base.slice(dot).toLowerCase())
  );
}

/** The module string of an import/export source node, or a fallback. */
function moduleOf(node) {
  return typeof node?.value === "string" ? node.value : "the defining module";
}

const rule = {
  meta: {
    type: "problem",
    docs: {
      description: "Outlaw re-exports of imports outside index files.",
    },
    schema: [],
    messages: {
      exportFrom:
        "Re-exports are outlawed outside index files: update consumers to import from '{{module}}' directly and delete this re-export. If this file is meant to be a public surface, it should be an index file.",
      exportStar:
        "`export *` is outlawed outside index files: import from '{{module}}' directly, or make this file an index file whose exports are named explicitly.",
      reExportedImport:
        "'{{name}}' is an import re-exported back out — outside index files, consumers import from '{{module}}' directly. Export only what this file defines.",
    },
  },

  create(context) {
    if (isIndexFile(context.filename)) return {};

    /** local binding name -> the module it was imported from. */
    const importedBindings = new Map();

    return {
      // Imports are collected up front so a shim whose import trails its
      // export (`export { x };` first — imports hoist at runtime) is still
      // caught: visitors fire in source order, but the whole program is
      // known before any export is judged. The `Program` visitor fires on
      // entry, before any descendant statement is visited.
      Program(program) {
        for (const statement of program.body) {
          if (
            statement.type === "ImportDeclaration" &&
            typeof statement.source?.value === "string"
          ) {
            for (const spec of statement.specifiers) {
              importedBindings.set(spec.local.name, statement.source.value);
            }
          }
        }
      },

      ExportAllDeclaration(node) {
        context.report({
          node,
          messageId: "exportStar",
          data: { module: moduleOf(node.source) },
        });
      },

      ExportNamedDeclaration(node) {
        if (node.source) {
          context.report({
            node,
            messageId: "exportFrom",
            data: { module: moduleOf(node.source) },
          });
          return;
        }
        for (const spec of node.specifiers) {
          const module = importedBindings.get(spec.local.name);
          if (module !== undefined) {
            context.report({
              node: spec,
              messageId: "reExportedImport",
              data: { name: spec.local.name, module },
            });
          }
        }
      },
    };
  },
};

export const noReExports = rule;
export default rule;
