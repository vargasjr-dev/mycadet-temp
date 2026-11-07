// @ts-check
/**
 * `imports-first` — every import statement must sit at the top of the file,
 * before any other statement.
 *
 * A module's dependency list is a contract you should be able to read in one
 * glance at the top of the file. An import dropped in the middle of the file
 * (next to the block that uses it) hides that contract, breaks the reader's
 * expectations, and usually signals that the block below should be a module
 * of its own. This rule encodes that review.
 *
 * Flagged: any `ImportDeclaration` that follows a non-import, non-comment,
 * non-whitespace statement in the program.
 *
 * Not flagged: imports inside the leading docblock/comment region — comments
 * and blank lines don't count as statements.
 */

/** The rule object exported for `eslint.config` `plugins` registries. */
export const importsFirst = {
  meta: {
    type: "suggestion",
    fixable: "code",
    docs: {
      description: "imports must be hoisted to the top of the file",
    },
    schema: [],
    messages: {
      hoist: "Import must be at the top of the file, before other statements.",
    },
  },
  create(context) {
    let seenStatement = false;
    let firstNonImport = undefined;
    return {
      Program(program) {
        for (const statement of program.body) {
          if (statement.type === "ImportDeclaration") {
            if (seenStatement) {
              context.report({
                node: statement,
                messageId: "hoist",
                fix(fixer) {
                  if (!firstNonImport) return null;
                  const sourceText = context.sourceCode.text;
                  const hoisted = sourceText.slice(
                    statement.range[0],
                    statement.range[1],
                  );
                  if (!hoisted) return null;
                  return [
                    fixer.insertTextBefore(firstNonImport, `${hoisted}\n`),
                    fixer.remove(statement),
                  ];
                },
              });
            }
          } else if (!seenStatement) {
            seenStatement = true;
            firstNonImport = statement;
          }
        }
      },
    };
  },
};
