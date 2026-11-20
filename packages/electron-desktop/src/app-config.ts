/**
 * The desktop identity constants all three clients (macOS, Windows, Linux)
 * share: the `app://` scheme the packaged renderer is served from and the
 * two renderer-base URLs the main/auxiliary windows load. Each client's
 * `app-config.ts` re-exports from here so a mount change lands once —
 * drift between clients used to be invisible until a renderer load broke.
 *
 * The bases split with the app/web bundle split (see clients/README.md):
 *
 * - `APP_RENDERER_BASE_PROD` — the MAIN window's root, rendering the app
 *   shell (the root-based `@mycadet/app` standalone build).
 * - `RENDERER_BASE_PROD` — auxiliary windows' base (about, command
 *   palette, companion, popouts, …), which still render web routes. They
 *   append their own subpath (`/about`, future `/conversations/<id>`,
 *   etc.) onto the `/web/assistant` mount the app shell iframes the web
 *   bundle through.
 *
 * Dev builds ride the same `app://` protocol handler (`bun run dev` packs
 * the same dists from the source trees), except where a client opts into a
 * remote dev server (`CADET_DEV_URL`) — the dev helpers below serve those.
 */

export const APP_PROTOCOL = "app";
export const APP_HOST = "mycadet.ai";

export const RENDERER_BASE_PROD = `${APP_PROTOCOL}://${APP_HOST}/web/assistant`;

export const APP_RENDERER_BASE_PROD = `${APP_PROTOCOL}://${APP_HOST}`;

const DEV_SERVER_FALLBACK_URL = "http://localhost:5173/assistant";

/**
 * Renderer-base URL in dev. Honors `CADET_DEV_URL` so the launcher can
 * point at whichever Vite-or-equivalent is up (standalone Vite at :5173,
 * or vel's edge proxy at :3000). Strips any trailing slash so callers can
 * append `/<subpath>` without producing `//`.
 */
export const getDevRendererBase = (): string =>
  (process.env.CADET_DEV_URL ?? DEV_SERVER_FALLBACK_URL).replace(/\/+$/, "");

/** Whether this process loads the renderer through the app protocol. */
export const usesAppProtocolRenderer = (isPackaged: boolean): boolean =>
  isPackaged || process.env.CADET_LOCAL_RENDERER === "true";

/**
 * Renderer-base URL for the current process, for auxiliary windows and any
 * other surface that must land on the same origin as the main window.
 * Follows `usesAppProtocolRenderer`, not `isPackaged` alone: with
 * `CADET_LOCAL_RENDERER` the main window is served over `app://` while
 * `CADET_DEV_URL` points at the remote platform, and loading that remote
 * URL would hand a window a foreign origin that the IPC sender guard
 * rejects.
 */
export const getRendererBase = (isPackaged: boolean): string =>
  usesAppProtocolRenderer(isPackaged)
    ? RENDERER_BASE_PROD
    : getDevRendererBase();

/** Like {@link getRendererBase}, but rooted for the app shell. */
export const getRendererRootUrl = (isPackaged: boolean): string =>
  usesAppProtocolRenderer(isPackaged)
    ? APP_RENDERER_BASE_PROD
    : `${getDevRendererBase()}/`;
