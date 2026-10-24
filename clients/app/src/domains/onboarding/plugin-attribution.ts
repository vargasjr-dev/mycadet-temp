/**
 * Plugins the user should start with based on where they came from.
 *
 * When a logged-in user with no assistant clicks "Hatch an assistant with this
 * plugin" on a marketing plugin page, the marketing side routes them into
 * onboarding with the plugin carried as a `?plugin=<name>` query parameter.
 * The api-key step carries it forward onto the funnel continuation URL so the
 * research runner can read it off the URL and pre-install that plugin.
 *
 * Both repos MUST agree on {@link ATTRIBUTED_PLUGIN_PARAM} (web's fuller
 * module: `domains/onboarding/plugin-attribution.ts`).
 */

/** Query-param name carrying the marketing-attributed plugin. */
export const ATTRIBUTED_PLUGIN_PARAM = "plugin";

/**
 * The attributed plugin id from a query string, or `null` when there is none.
 * `search` defaults to the current URL's query so the runner can read it
 * without threading; pass an explicit string in tests.
 */
function readAttributedPluginId(search: string): string | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return null;
  }
  const id = params.get(ATTRIBUTED_PLUGIN_PARAM)?.trim();
  return id ? id : null;
}

/**
 * Plugin names to install for the user based on marketing attribution — the
 * plugin they clicked "Hatch an assistant with this plugin" on before
 * onboarding. Empty when there's none.
 */
export function pluginsFromAttribution(
  search: string = typeof window !== "undefined" ? window.location.search : "",
): string[] {
  const pluginId = readAttributedPluginId(search);
  return pluginId ? [pluginId] : [];
}
