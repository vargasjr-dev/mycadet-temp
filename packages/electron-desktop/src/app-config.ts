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
 * - `RENDERER_BASE_PROD` — auxiliary windows' base (command
 *   palette, companion, popouts, …), which still render web routes. They
 *   append their own subpath (`/conversations/<id>`,
 *   etc.) onto the `/web/assistant` mount the app shell iframes the web
 *   bundle through.
 *
 * Dev builds ride the same `app://` protocol handler: `bun run dev` packs
 * the same dists from the source trees, so one origin serves every mode.
 */

export const APP_PROTOCOL = "app";
export const APP_HOST = "mycadet.ai";

export const RENDERER_BASE_PROD = `${APP_PROTOCOL}://${APP_HOST}/web/assistant`;

export const APP_RENDERER_BASE_PROD = `${APP_PROTOCOL}://${APP_HOST}`;

/**
 * Renderer-base URL for the current process, for auxiliary windows and any
 * other surface that must land on the same origin as the main window. Every
 * process loads the renderer through the app protocol — packaged builds read
 * the staged resources, dev reads the source-tree builds — so one origin
 * serves all of them and the IPC sender guard never meets a foreign one.
 */
export const getRendererBase = (): string => RENDERER_BASE_PROD;

/** Like {@link getRendererBase}, but rooted for the app shell. */
export const getRendererRootUrl = (): string => APP_RENDERER_BASE_PROD;
