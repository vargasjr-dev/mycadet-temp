/**
 * The path prefix this web bundle is served under, derived from the entry
 * URL. The bundle mounts at different depths per host — root-served (the
 * desktop's `app://` handler and a dev server), or behind a serving prefix
 * (the gateway's versioned artifact path `/web/<version>/assistant/…`, a
 * tenant subpath) — and the route tree's `/assistant/*` paths only match
 * when the serving prefix is stripped first. Everything before the FIRST
 * real `/assistant` segment is the prefix; mounting at index 0 (or no
 * `/assistant` at all) means no basename.
 *
 * The router (`routes.tsx`) and the pathname strippers
 * (`conversation-navigation`) must agree on this, so both derive it from
 * here instead of a build-time constant — the serving depth is a property
 * of where the bundle was loaded from, not of the build.
 */
export function bundleBasename(location = window.location): string | undefined {
  const match = /\/assistant(?:\/|$)/.exec(location.pathname);
  return match && match.index > 0
    ? location.pathname.slice(0, match.index).replace(/\/+$/, "")
    : undefined;
}
