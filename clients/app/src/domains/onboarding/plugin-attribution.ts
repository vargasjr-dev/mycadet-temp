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
