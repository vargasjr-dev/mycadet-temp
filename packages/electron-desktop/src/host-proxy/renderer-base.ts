import { APP_HOST, APP_PROTOCOL } from "../app-config";

const RENDERER_MOUNT = "/assistant";

/**
 * The renderer base the ui-snapshot executor points at. Every build mode —
 * packaged or dev — serves the renderer over `app://`, so the base is a
 * constant rather than a per-client input.
 */
export const resolveHostProxyRendererBase = (): string =>
  `${APP_PROTOCOL}://${APP_HOST}${RENDERER_MOUNT}`;
