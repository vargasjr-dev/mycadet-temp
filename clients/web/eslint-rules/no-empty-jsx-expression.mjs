/**
 * Custom ESLint rule: no-empty-jsx-expression.
 *
 * An empty expression container (`{}`) in JSX children does nothing: it
 * renders nothing, and unlike a comment container (a JSX comment, brace
 * star brace) it carries no information. The empty form reads as a
 * leftover placeholder and survives for years because it is invisible in
 * review.
 */

const MESSAGE_ID = "emptyJsxExpression";

export const noEmptyJsxExpression = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow empty JSX expression containers (`{}`) among JSX children.",
    },
    schema: [],
    messages: {
      [MESSAGE_ID]:
        "Empty JSX expression container (`{}`) renders nothing. Remove it.",
    },
  },

  create(context) {
    return {
      JSXExpressionContainer(node) {
        if (node.expression.type !== "JSXEmptyExpression") {
          return;
        }
        // A comment container is also an empty expression to the parser;
        // only the whitespace-only form is clutter.
        const text = context.sourceCode.getText(node);
        if (!/^\s*$/.test(text.slice(1, -1))) {
          return;
        }
        context.report({ node, messageId: MESSAGE_ID });
      },
    };
  },
};
