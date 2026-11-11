// @ts-check
/**
 * `no-empty-imports` — outlaw import declarations that bind no names.
 *
 * `import type {} from "y"` compiles to nothing: TypeScript erases it
 * entirely, so the "dependency" it describes does not exist at runtime and
 * only exists in the type graph. `import {} from "y"` is the same statement
 * with the braces kept — a side-effect import written in a shape that
 * *looks* like it is about to name bindings. Both are husks, usually left
 * behind by a codemod that removed the last binding (a knip sweep, an
 * unused-type cleanup) and kept the shell of the import alive.
 *
 * The fix is almost always deletion: if the file uses nothing from the
 * module, the import line goes away. Two legitimate survivors exist:
 * - a real side-effect dependency (`import "y"`) — write it bare, so the
 *   intent is explicit (this is how composition roots wire seams);
 * - a module that must join the type program for its declarations to apply
 *   (module augmentation) — then import a name from it, or use a bare
 *   value import so the dependency is a visible, runtime-real edge.
 *
 * Flagged shapes:
 * - `import type {} from "y"` (empty type import — erased at compile time)
 * - `import {} from "y"` (empty named import)
 *
 * Not flagged: `import "y"` — a bare side-effect import is an intentional
 * statement that the module's evaluation matters, and carries no pretense
 * of bindings. `import type * as ns from "y"` also survives: it binds
 * `ns`, and an unused namespace is `no-unused-vars`' territory.
 */

/**
 * Whether the import declaration's source text declares an empty named
 * list. The AST gives `import {} from "y"` and `import "y"` the same shape
 * (zero specifiers), so the braces only exist in the text.
 * @param {import("eslint").SourceCode} sourceCode
 * @param {import("estree").ImportDeclaration} node
 */
function hasEmptyNamedList(sourceCode, node) {
  const text = sourceCode.getText(node);
  return /^import\s*(?:type\s*)?\{/.test(text);
}

/** The rule object exported for `eslint.config` `plugins` registries. */
export const noEmptyImports = {
  meta: {
    type: "problem",
    docs: {
      description: "outlaw import declarations that bind no names",
    },
    schema: [],
    messages: {
      emptyTypeImport:
        "This type import binds no names — TypeScript erases the whole declaration, so the dependency it describes does not exist. Delete it, or import the names this file actually uses.",
      emptyImport:
        'This import binds no names. For side effects only, write a bare `import "source"`; otherwise import the names this file actually uses.',
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        if (node.specifiers.length > 0) return;
        if (!hasEmptyNamedList(context.sourceCode, node)) return;
        context.report({
          node,
          messageId:
            node.importKind === "type" ? "emptyTypeImport" : "emptyImport",
        });
      },
    };
  },
};
