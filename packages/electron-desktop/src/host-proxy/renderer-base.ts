import { app } from "electron";

const APP_PROTOCOL = "app";
const APP_HOST = "mycadet.ai";
const RENDERER_MOUNT = "/assistant";
const DEV_SERVER_FALLBACK_URL = "http://localhost:5173/assistant";

/**
 * The renderer base the ui-snapshot executor points at. The packaged shell
 * is served over `app://`; dev honors `CADET_DEV_URL` (or the local Vite
 * default). Identical in every desktop client, so the shared host-proxy
 * runtime resolves it itself instead of taking it as a per-client input.
 */
export const resolveHostProxyRendererBase = (): string =>
  app.isPackaged || process.env.CADET_LOCAL_RENDERER === "true"
    ? `${APP_PROTOCOL}://${APP_HOST}${RENDERER_MOUNT}`
    : (process.env.CADET_DEV_URL ?? DEV_SERVER_FALLBACK_URL).replace(/\/+$/, "");
