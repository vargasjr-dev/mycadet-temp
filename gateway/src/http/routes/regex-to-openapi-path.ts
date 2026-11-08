/**
 * Convert a raw-regex dispatch path into the `{param}` template the spec and
 * the schema guard compare against.
 *
 * - Named capture groups become semantic `{name}` segments (published routes
 *   must name their groups so the spec reads `/contacts/{contact_id}`).
 * - Positional capture groups become `{paramN}` in match order (the spelling
 *   the schema guard has always used for dispatch-only regexes).
 * - Lookarounds, anchors, and the optional trailing slash are dispatch
 *   mechanics — they have no spec meaning and disappear.
 *
 * Returns undefined when something regex-shaped survives the conversion
 * (alternations, quantifiers we don't model) — the caller decides whether
 * that's fatal or skippable.
 */
export function regexToOpenApiPath(regex: RegExp): string | undefined {
  let source = regex.source;
  // Normalize escaped slashes so the template reads like a path.
  source = source.replace(/\\\//g, "/");
  // Lookarounds constrain which values match, not the path's shape.
  source = source.replace(/\(\?<?[=!][^)]*\)/g, "");
  // Named capture groups → `{name}`.
  source = source.replace(
    /\(\?<([A-Za-z0-9_]+)>[^)]*\)/g,
    (_m, name) => `{${name}}`,
  );
  // Positional capture groups → `{paramN}`.
  let paramIndex = 0;
  source = source.replace(
    /\((\[\^\/\]\+|\.\+(?:\?)?)\)/g,
    () => `{param${++paramIndex}}`,
  );
  // Anchors and the trailing-slash tolerance are dispatch mechanics too.
  source = source.replace(/^\^/, "").replace(/\$$/, "").replace(/\/\?$/, "");
  if (/[()[\]\\*+?^$|]/.test(source.replace(/\{[A-Za-z0-9_]+\}/g, ""))) {
    return undefined;
  }
  return source;
}
