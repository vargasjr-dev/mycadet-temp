// @ts-check
/** `imports-first` — imports must sit at the top of the file, before any other statement. */

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
