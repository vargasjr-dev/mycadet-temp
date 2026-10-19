/**
 * Shared application identity constants for the main process.
 *
 * `app-protocol` and `app-host` define the custom scheme the packaged
 * renderer is served from. They're referenced from at least three
 * places today (`index.ts` for `protocol.registerSchemesAsPrivileged`
 * + the `protocol.handle` registration, `main-window.ts` for the
 * BrowserWindow load URL and the same-origin navigation guard,
 * `about.ts` for the About window's prod URL), so they live here as a
 * single source of truth. Drift between callers would have shown up
 * as a broken renderer load rather than a build error, which is
 * exactly the kind of thing a small shared module prevents.
 *
 * The renderer-base URLs split with the app/web bundle split (see
 * clients/README.md):
 *
 * - The MAIN window renders the app shell (`@mycadet/app` standalone build,
 *   root-based). `APP_RENDERER_BASE_PROD` is the packaged root the `app://`
 *   protocol handler resolves to; dev honors `CADET_APP_DEV_URL` (the
 *   clients/app Vite default at port 3001).
 *
 * - Auxiliary windows (about, command palette, companion, popouts, …) still
 *   render web routes. They keep the `/assistant` base the web bundle's
 *   `base` setting requires: `RENDERER_BASE_PROD` packaged, `CADET_DEV_URL`
 *   (web Vite at :5173) in dev.
 */

export const APP_PROTOCOL = "app";
export const APP_HOST = "mycadet.ai";

const WEB_DEV_FALLBACK_URL = "http://localhost:5173/assistant";
const APP_DEV_FALLBACK_URL = "http://localhost:3001";

/**
 * Renderer-base URL for auxiliary windows, which render web routes.
 * They append their own subpath (`/about`, future `/conversations/<id>`,
 * etc.) onto the `/assistant` mount the web bundle's `base` requires.
 */
export const RENDERER_BASE_PROD = `${APP_PROTOCOL}://${APP_HOST}/assistant`;

/**
 * Auxiliary-window base in dev. Honors `CADET_DEV_URL` so the launcher
 * can point at whichever Vite-or-equivalent is up (web Vite at :5173).
 * Strips any trailing slash so callers can append `/<subpath>` without
 * producing `//`.
 */
export const getDevRendererBase = (): string =>
  (process.env.CADET_DEV_URL ?? WEB_DEV_FALLBACK_URL).replace(/\/+$/, "");

/**
 * Renderer-base URL for the MAIN window, which renders the app shell
 * (root-based `@mycadet/app` standalone build — no mount suffix).
 */
export const APP_RENDERER_BASE_PROD = `${APP_PROTOCOL}://${APP_HOST}`;

/**
 * Main-window app-shell base in dev. Honors `CADET_APP_DEV_URL` so the
 * launcher can point at the app's Vite dev server (:3001). Strips any
 * trailing slash like the web base does.
 */
export const getAppDevRendererBase = (): string =>
  (process.env.CADET_APP_DEV_URL ?? APP_DEV_FALLBACK_URL).replace(/\/+$/, "");

/**
 * SPA-root URL the main BrowserWindow loads.
 *
 * Dev and prod resolve the root document differently. In dev the app Vite
 * dev server answers on `/` (root-based build); the trailing slash is kept
 * so the browser-router root mounts without a redirect hop. In prod the
 * `app://` protocol handler maps the slashless `/` to the app dist's
 * `index.html`, so `APP_RENDERER_BASE_PROD` loads as-is.
 */
export const getRendererRootUrl = (isPackaged: boolean): string =>
  isPackaged ? APP_RENDERER_BASE_PROD : `${getAppDevRendererBase()}/`;
