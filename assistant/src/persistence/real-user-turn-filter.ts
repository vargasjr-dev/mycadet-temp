


/**
 * Raw-string form of {@link realUserTurnContentFilter}, for queries built as
 * plain SQL template strings (`rawAll` sites). Same fragment, one source.
 *
 * `finalized = 1`: the grouped tool-result row is a USER-role row reserved
 * in-flight (`ensureToolResultRowReserved`), and while it streams its content
 * is a `{ ref }` pointer that does not contain the tool_result text the
 * exclusions match. Without this predicate it counts as a real user turn
 * mid-tool-execution and stops counting once the content folds inline.
 *
 * Bare `[]` content is deliberately NOT excluded: a hidden send persists its
 * user row with empty display content (`processMessage` with
 * `displayContent: ""`) and still runs a turn, so `[]` rows are legitimate
 * turns. The cost is a narrow pre-existing window in the writer-creation
 * fallback, where the tool-result row is born finalized with a `[]`
 * placeholder and counts until the first content write lands; that window is
 * rare (writer creation failure only) and transient, and closing it needs a
 * signal that distinguishes the placeholder from a real empty-display turn.
 */
export function realUserTurnContentFilterSql(alias: string): string {
  return (
    `${alias}.finalized = 1 ` +
    `AND ${alias}.content NOT LIKE '%"type":"tool\\_result"%' ESCAPE '\\' ` +
    `AND ${alias}.content NOT LIKE '%"type":"web\\_search\\_tool\\_result"%' ESCAPE '\\'`
  );
}
