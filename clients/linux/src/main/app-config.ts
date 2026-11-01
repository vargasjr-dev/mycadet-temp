/**
 * Shared application identity constants for the main process.
 *
 * `APP_PROTOCOL` and `APP_HOST` define the custom scheme the packaged
 * renderer is served from; `index.ts` registers it privileged and the shared
 * app-protocol handler serves both renderer roots through it, and
 * `main-window.ts` derives the BrowserWindow load URL and the same-origin
 * navigation guard from it.
 */

export const APP_PROTOCOL = "app";
export const APP_HOST = "mycadet.ai";

declare const __CADET_BUILD_SHA__: string;
declare const __CADET_ENVIRONMENT__: string;

export const LINUX_RELEASE_INFO = {
  commitSha:
    typeof __CADET_BUILD_SHA__ === "string" ? __CADET_BUILD_SHA__ : "unknown",
  releaseChannel:
    typeof __CADET_ENVIRONMENT__ === "string"
      ? __CADET_ENVIRONMENT__
      : "production",
};

const DEV_SERVER_FALLBACK_URL = "http://localhost:5173/assistant";

export const RENDERER_BASE_PROD = `${APP_PROTOCOL}://${APP_HOST}/assistant`;

/**
 * App-shell base URL for the main window, which renders the app shell
 * (root-based `@mycadet/app` standalone build — no mount suffix; the
 * shell iframes the web bundle on the `/assistant` mount). Auxiliary
 * windows keep `RENDERER_BASE_PROD`, the web routes' base.
 */
export const APP_RENDERER_BASE_PROD = `${APP_PROTOCOL}://${APP_HOST}`;

export const getDevRendererBase = (): string =>
  (process.env.CADET_DEV_URL ?? DEV_SERVER_FALLBACK_URL).replace(/\/+$/, "");

export const getRendererBase = (isPackaged: boolean): string =>
  usesAppProtocolRenderer(isPackaged)
    ? RENDERER_BASE_PROD
    : getDevRendererBase();

export const usesAppProtocolRenderer = (isPackaged: boolean): boolean =>
  isPackaged || process.env.CADET_LOCAL_RENDERER === "true";

export const getRendererRootUrl = (isPackaged: boolean): string =>
  usesAppProtocolRenderer(isPackaged)
    ? APP_RENDERER_BASE_PROD
    : `${getDevRendererBase()}/`;
