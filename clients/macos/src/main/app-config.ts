/**
 * Shared application identity constants for the main process.
 *
 * `app-protocol` and `app-host` define the custom scheme the renderer is
 * served from. They're referenced from at least three places today
 * (`index.ts` for `protocol.registerSchemesAsPrivileged` + the
 * `protocol.handle` registration, `main-window.ts` for the BrowserWindow
 * load URL and the same-origin navigation guard, `about.ts` for the About
 * window's URL), so they live here as a single source of truth. Drift
 * between callers would have shown up as a broken renderer load rather
 * than a build error, which is exactly the kind of thing a small shared
 * module prevents.
 *
 * The renderer-base URLs split with the app/web bundle split (see
 * clients/README.md), and both are build-independent: `bun run dev` packs
 * the same dists from the source trees and the `app://` protocol handler
 * registers in dev too, so dev and packaged loads use the same origins.
 *
 * - The MAIN window renders the app shell (`@mycadet/app` standalone
 *   build, root-based): `APP_RENDERER_BASE_PROD` is the root the `app://`
 *   protocol handler resolves to.
 * - Auxiliary windows (about, command palette, companion, popouts, …) still
 *   render web routes. They keep the `/assistant` base the web bundle's
 *   `base` setting requires: `RENDERER_BASE_PROD`.
 */

export const APP_PROTOCOL = "app";
export const APP_HOST = "mycadet.ai";

/**
 * Renderer-base URL for auxiliary windows, which render web routes.
 * They append their own subpath (`/about`, future `/conversations/<id>`,
 * etc.) onto the `/assistant` mount the web bundle's `base` requires.
 */
export const RENDERER_BASE_PROD = `${APP_PROTOCOL}://${APP_HOST}/assistant`;

/**
 * Renderer-base URL for the MAIN window, which renders the app shell
 * (root-based `@mycadet/app` standalone build — no mount suffix).
 */
export const APP_RENDERER_BASE_PROD = `${APP_PROTOCOL}://${APP_HOST}`;
